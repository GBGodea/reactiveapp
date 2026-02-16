package com.reactive.generator.service;

import com.reactive.generator.model.Reading;
import com.reactive.generator.model.ReadingEntity;
import com.reactive.generator.model.Sensor;
import com.reactive.generator.model.SensorType;
import com.reactive.generator.repository.ReadingRepository;
import com.reactive.generator.repository.SensorRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class IotEngine {

    private final SensorRepository sensorRepo;
    private final ReadingRepository readingRepo;

    private final Sinks.Many<Sensor> sensorAdds =
            Sinks.many().multicast().onBackpressureBuffer();

    private final Sinks.Many<Reading> readingOut =
            Sinks.many().multicast().onBackpressureBuffer(50_000, false);

    private final Sinks.Many<Reading> persistIn =
            Sinks.many().multicast().onBackpressureBuffer(50_000, false);

    private final Scheduler emitScheduler = Schedulers.newSingle("reading-out");

    private final ConcurrentHashMap<String, Disposable> running = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Double> biasBySensorId = new ConcurrentHashMap<>();

    private final AtomicLong droppedPersist = new AtomicLong(0);

    public IotEngine(SensorRepository sensorRepo, ReadingRepository readingRepo) {
        this.sensorRepo = sensorRepo;
        this.readingRepo = readingRepo;
    }

    @PostConstruct
    public void start() {
        Flux<Sensor> sensors = sensorRepo.findByEnabledTrue()
                .doOnError(e -> System.out.println("[ENGINE] sensorRepo error: " + e))
                .onErrorResume(e -> Flux.empty())
                .concatWith(sensorAdds.asFlux())
                .filter(s -> s.enabled() && s.id() != null)
                .distinct(Sensor::id);

        sensors
                .doOnNext(this::startIfAbsent)
                .subscribe(
                        v -> { },
                        e -> System.out.println("[ENGINE] sensors subscribe error: " + e)
                );

        persistIn.asFlux()
                .onBackpressureDrop(r -> droppedPersist.incrementAndGet())
                .bufferTimeout(1000, Duration.ofSeconds(1))
                .filter(batch -> !batch.isEmpty())
                .concatMap(this::saveBatchSafely)
                .onErrorResume(e -> {
                    System.out.println("[ENGINE] persist pipeline error: " + e);
                    return Mono.empty();
                })
                .subscribe();
    }

    public Flux<Reading> readings() {
        return readingOut.asFlux();
    }

    public Flux<Sensor> listSensors() {
        return sensorRepo.findAll();
    }

    public Mono<Sensor> addSensor(Sensor s) {
        return sensorRepo.save(s)
                .doOnNext(sensorAdds::tryEmitNext);
    }

    public Mono<Boolean> existsDeviceId(String deviceId) {
        return sensorRepo.existsByDeviceId(deviceId);
    }

    public Mono<Boolean> existsSensorId(String sensorId) {
        return sensorRepo.existsById(sensorId);
    }

    public Mono<Void> deleteSensor(String sensorId) {
        return Mono.fromRunnable(() -> stopRuntime(sensorId))
                .then(sensorRepo.deleteById(sensorId))
                .then();
    }

    public Mono<Double> adjustBias(String sensorId, double delta) {
        return Mono.fromSupplier(() -> biasBySensorId.merge(sensorId, delta, Double::sum));
    }

    private void startIfAbsent(Sensor s) {
        if (!s.enabled()) return;
        if (s.id() == null) return;

        running.computeIfAbsent(s.id(), id -> {
            System.out.println("[ENGINE] start sensor stream: id=" + id + " type=" + s.type());

            return sensorToReadings(s)
                    .publishOn(emitScheduler)
                    .doOnNext(r -> {
                        var res = readingOut.tryEmitNext(r);
                        if (res.isFailure()) {
                            System.out.println("[ENGINE] realtime emit failed: " + res + " reading=" + r);
                        }

                        var pres = persistIn.tryEmitNext(r);
                        if (pres.isFailure()) {
                            long n = droppedPersist.incrementAndGet();
                            if (n % 10_000 == 0) {
                                System.out.println("[ENGINE] persist drop total=" + n + " last=" + pres);
                            }
                        }
                    })
                    .doOnError(e -> System.out.println("[ENGINE] sensor pipeline error: " + e))
                    .subscribe(
                            v -> { },
                            e -> System.out.println("[ENGINE] sensor " + id + " subscribe error: " + e)
                    );
        });
    }

    private void stopRuntime(String sensorId) {
        Disposable d = running.remove(sensorId);
        if (d != null) {
            System.out.println("[ENGINE] stop sensor stream: id=" + sensorId);
            d.dispose();
        }
        biasBySensorId.remove(sensorId);
    }

    private Mono<Void> saveBatchSafely(List<Reading> batch) {
        return readingRepo.saveAll(Flux.fromIterable(batch).map(this::toEntity))
                .then()
                .onErrorResume(e -> {
                    System.out.println("[ENGINE] save batch failed size=" + batch.size() + " err=" + e);
                    return Mono.empty();
                });
    }

    private ReadingEntity toEntity(Reading r) {
        return new ReadingEntity(null, r.sensorId(), r.deviceId(), r.type(), r.ts(), r.value());
    }

    private record State(double temp, double hum, int motion, int burstLeft) { }

    private Flux<Reading> sensorToReadings(Sensor s) {
        if (!s.enabled()) return Flux.empty();

        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        double baseTemp = clamp(24 + rnd.nextDouble(-3, 3), 15, 35);
        double baseHum = clamp(60 + rnd.nextDouble(-4, 4), 50, 70);

        State init = new State(baseTemp, baseHum, 0, 0);

        return Flux.interval(s.period())
                .onBackpressureLatest()
                .scan(init, (st, tick) -> evolve(st, baseTemp, baseHum))
                .skip(1)
                .map(st -> {
                    double raw = valueByType(s.type(), st);
                    double bias = biasBySensorId.getOrDefault(s.id(), 0.0);
                    double v = raw + bias;

                    if (s.type() == SensorType.THERMOMETER) v = clamp(v, 15, 35);
                    if (s.type() == SensorType.HUMIDITY) v = clamp(v, 0, 100);
                    if (s.type() == SensorType.MOTION) v = (v >= 0.5) ? 1 : 0;

                    return new Reading(
                            s.id(),
                            s.deviceId(),
                            s.type(),
                            Instant.now(),
                            v
                    );
                })
                .onErrorResume(e -> {
                    System.out.println("[ENGINE] sensor " + s.id() + " stream error: " + e);
                    return Flux.empty();
                });
    }

    private State evolve(State st, double baseTemp, double baseHum) {
        double nextTemp = clamp(stepToward(st.temp, baseTemp, 0.08, 0.12), 15, 35);
        double nextHum  = clamp(stepToward(st.hum,  baseHum,  0.05, 0.10), 50, 70);

        ThreadLocalRandom r = ThreadLocalRandom.current();
        int burstLeft = st.burstLeft;
        int motion;

        if (burstLeft > 0) {
            motion = 1;
            burstLeft--;
        } else {
            boolean start = r.nextDouble() < 0.03;
            if (start) {
                burstLeft = r.nextInt(2, 7);
                motion = 1;
                burstLeft--;
            } else {
                motion = 0;
            }
        }
        return new State(nextTemp, nextHum, motion, burstLeft);
    }

    private double valueByType(SensorType type, State st) {
        return switch (type) {
            case THERMOMETER -> round1(st.temp);
            case HUMIDITY -> round1(st.hum);
            case MOTION -> st.motion;
        };
    }

    private static double stepToward(double value, double target, double k, double noiseStd) {
        double noise = ThreadLocalRandom.current().nextGaussian() * noiseStd;
        return value + k * (target - value) + noise;
    }

    private static double round1(double x) {
        return Math.round(x * 10.0) / 10.0;
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
    }
}
