package com.reactive.main.controller;

import java.time.Duration;

import com.reactive.main.dto.Reading;
import com.reactive.main.service.ProducerClient;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
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
    public Flux<ServerSentEvent<Reading>> stream() {

        Flux<ServerSentEvent<Reading>> data = client.readings()
                .doOnSubscribe(s -> System.out.println("[SSE] subscribed"))
                .doOnNext(r -> System.out.println("[SSE] reading: " + r))
                .map(r -> ServerSentEvent.builder(r).build());

        Flux<ServerSentEvent<Reading>> heartbeat = Flux.interval(Duration.ofSeconds(10))
                .map(i -> ServerSentEvent.<Reading>builder().comment("ka").build());

        return Flux.merge(data, heartbeat);
    }

}
