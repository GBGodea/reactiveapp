package com.reactive.main.controller;

import com.reactive.main.dto.Reading;
import com.reactive.main.service.ProducerClient;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamController {
    private final ProducerClient client;

    public StreamController(ProducerClient client) {
        this.client = client;
    }

    @GetMapping(value = "/api/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<Reading> stream() {
        return client.readings();
    }
}
