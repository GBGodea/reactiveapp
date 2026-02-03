package com.reactive.generator.repository;

import com.reactive.generator.model.Sensor;
import org.springframework.data.mongodb.repository.ReactiveMongoRepository;
import reactor.core.publisher.Flux;

public interface SensorRepository extends ReactiveMongoRepository<Sensor, String> {
    Flux<Sensor> findByEnabledTrue();
}
