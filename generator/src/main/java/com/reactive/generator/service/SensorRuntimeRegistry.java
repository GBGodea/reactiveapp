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
import reactor.core.publisher.Sinks;

import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

@Service
public class SensorRuntimeRegistry {

    private final SensorRepository sensorRepo;
    private final ReadingRepository readingRepo;

    private final Sinks.Many<Sensor> newSensors = Sinks.many().multicast().onBackpressureBuffer();

    private final Sinks.Many<Reading> readingsSink = Sinks.many().multicast().onBackpressureBuffer();

    private final ConcurrentHashMap<String, Disposable> running = new ConcurrentHashMap<>();

    public SensorRuntimeRegistry(SensorRepository sensorRepo, ReadingRepository readingRepo) {
        this.sensorRepo = sensorRepo;
        this.readingRepo = readingRepo;
    }

    @PostConstruct
    public void init() {
        sensorRepo.findByEnabledTrue()
                .doOnNext(this::startIfAbsent)
                .subscribe();

        newSensors.asFlux()
                .doOnNext(this::startIfAbsent)
                .subscribe();
    }

    public void onSensorAdded(Sensor saved) {
        var res = newSensors.tryEmitNext(saved);
    }

    public Flux<Reading> sharedReadings() {
        return readingsSink.asFlux();
    }

    private void startIfAbsent(Sensor s) {
        if (!s.enabled()) return;
        if (s.id() == null) return;

        running.computeIfAbsent(s.id(), id -> {
            var sub = sensorToReadings(s)
                    .flatMap(r -> readingRepo.save(toEntity(r)).thenReturn(r), 32)
                    .doOnNext(r -> readingsSink.tryEmitNext(r))
                    .subscribe();

            return sub;
        });
    }

    private ReadingEntity toEntity(Reading r) {
        return new ReadingEntity(null, r.sensorId(), r.deviceId(), r.type(), r.ts(), r.value());
    }

    private record SensorState(
            double tempC,
            double humidity,
            int motion,
            int motionBurstLeft,
            Instant ts
    ) {}

    private Flux<Reading> sensorToReadings(Sensor s) {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        double baseTemp = clamp(24.0 + rnd.nextDouble(-3.0, 3.0), 15.0, 35.0);
        double baseHum  = clamp(60.0 + rnd.nextDouble(-4.0, 4.0), 50.0, 70.0);

        var initial = new SensorState(baseTemp, baseHum, 0, 0, Instant.now());

        return Flux.interval(s.period())
                .scan(initial, (st, tick) -> evolve(st, baseTemp, baseHum))
                .skip(1)
                .map(st -> new Reading(
                        s.id(),
                        s.deviceId(),
                        s.type(),
                        st.ts(),
                        valueByType(s.type(), st)
                ));
    }

    private SensorState evolve(SensorState st, double baseTemp, double baseHum) {
        double nextTemp = clamp(stepToward(st.tempC(), baseTemp, 0.08, 0.12), 15.0, 35.0);
        double nextHum  = clamp(stepToward(st.humidity(), baseHum, 0.05, 0.10), 50.0, 70.0);

        ThreadLocalRandom r = ThreadLocalRandom.current();
        int burstLeft = st.motionBurstLeft();
        int motion;

        if (burstLeft > 0) {
            motion = 1;
            burstLeft -= 1;
        } else {
            boolean start = r.nextDouble() < 0.03;
            if (start) {
                burstLeft = r.nextInt(2, 7);
                motion = 1;
                burstLeft -= 1;
            } else {
                motion = 0;
            }
        }

        return new SensorState(nextTemp, nextHum, motion, burstLeft, Instant.now());
    }

    private double valueByType(SensorType type, SensorState st) {
        return switch (type) {
            case THERMOMETER -> round1(st.tempC());
            case HUMIDITY    -> round1(st.humidity());
            case MOTION      -> st.motion();
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
