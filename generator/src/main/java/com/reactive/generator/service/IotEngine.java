package com.reactive.generator.service;

import com.reactive.generator.model.Reading;
import com.reactive.generator.model.ReadingEntity;
import com.reactive.generator.model.Sensor;
import com.reactive.generator.model.SensorType;
import com.reactive.generator.repository.ReadingRepository;
import com.reactive.generator.repository.SensorRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

import java.time.Instant;
import java.util.concurrent.ThreadLocalRandom;

@Service
public class IotEngine {

    private final SensorRepository sensorRepo;
    private final ReadingRepository readingRepo;

    private final Sinks.Many<Sensor> sensorAdds =
            Sinks.many().multicast().onBackpressureBuffer();

    private final Sinks.Many<Reading> readingOut =
            Sinks.many().multicast().onBackpressureBuffer();

    public IotEngine(SensorRepository sensorRepo, ReadingRepository readingRepo) {
        this.sensorRepo = sensorRepo;
        this.readingRepo = readingRepo;
    }

    @PostConstruct
    public void start() {
        Flux<Sensor> sensors = sensorRepo.findByEnabledTrue()
                .concatWith(sensorAdds.asFlux())
                // упрощение: считаем что sensorId уникален и новых "дубликатов" нет
                .distinct(Sensor::id);

        // 1) Генерим readings
        // 2) Реактивно сохраняем в Mongo
        // 3) Параллельно пушим наружу для RSocket подписчиков
        sensors
                .flatMap(this::sensorToReadings)
                .flatMap(r -> readingRepo.save(toEntity(r)).thenReturn(r), 64)
                .doOnNext(r -> readingOut.tryEmitNext(r))
                .subscribe(); // запускаем реактивный граф (без блокировок)
    }

    public Mono<Sensor> addSensor(Sensor s) {
        // Реактивно сохраняем, затем реактивно "сигналим" в поток генерации
        return sensorRepo.save(s)
                .doOnNext(saved -> sensorAdds.tryEmitNext(saved));
    }

    public Flux<Reading> readings() {
        return readingOut.asFlux();
    }

    private ReadingEntity toEntity(Reading r) {
        return new ReadingEntity(null, r.sensorId(), r.deviceId(), r.type(), r.ts(), r.value());
    }

    // ---------- генерация "плавных" данных ----------
    private record State(double temp, double hum, int motion, int burstLeft) {}

    private Flux<Reading> sensorToReadings(Sensor s) {
        if (!s.enabled()) return Flux.empty();

        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        double baseTemp = clamp(24 + rnd.nextDouble(-3, 3), 15, 35);
        double baseHum  = clamp(60 + rnd.nextDouble(-4, 4), 50, 70);

        State init = new State(baseTemp, baseHum, 0, 0);

        return Flux.interval(s.period())
                .scan(init, (st, tick) -> evolve(st, baseTemp, baseHum))
                .skip(1)
                .map(st -> new Reading(
                        s.id(),
                        s.deviceId(),
                        s.type(),
                        Instant.now(),
                        valueByType(s.type(), st)
                ));
    }

    private State evolve(State st, double baseTemp, double baseHum) {
        double nextTemp = clamp(stepToward(st.temp, baseTemp, 0.08, 0.12), 15, 35);
        double nextHum  = clamp(stepToward(st.hum,  baseHum,  0.05, 0.10), 50, 70);

        // motion “всплесками”
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
            case HUMIDITY    -> round1(st.hum);
            case MOTION      -> st.motion;
        };
    }

    private static double stepToward(double value, double target, double k, double noiseStd) {
        double noise = ThreadLocalRandom.current().nextGaussian() * noiseStd;
        return value + k * (target - value) + noise;
    }

    private static double round1(double x) { return Math.round(x * 10.0) / 10.0; }
    private static double clamp(double v, double min, double max) { return Math.max(min, Math.min(max, v)); }
}
