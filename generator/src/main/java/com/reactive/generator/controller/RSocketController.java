package com.reactive.generator.controller;

import com.reactive.generator.model.Reading;
import com.reactive.generator.service.IotEngine;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.stereotype.Controller;
import reactor.core.publisher.Flux;

@Controller
public class RSocketController {
    private final IotEngine engine;

    public RSocketController(IotEngine engine) { this.engine = engine; }

    @MessageMapping("iot.readings")
    public Flux<Reading> readings() {
        return engine.readings();
    }
}
