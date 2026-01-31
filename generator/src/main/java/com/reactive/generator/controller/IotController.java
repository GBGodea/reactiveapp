package com.reactive.generator.controller;

import com.reactive.generator.model.Sensor;
import com.reactive.generator.model.SensorCreateRequest;
import com.reactive.generator.repository.SensorRepository;
import com.reactive.generator.service.IotEngine;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/iot")
public class IotController {
    private final IotEngine engine;

    public IotController(IotEngine engine) { this.engine = engine; }

    @PostMapping("/add")
    public Mono<Sensor> add(@RequestBody Mono<SensorCreateRequest> request) {
        return request
                .map(r -> new Sensor(null, r.name(), r.type(), r.deviceId(), r.period(), true))
                .flatMap(engine::addSensor);
    }
}
