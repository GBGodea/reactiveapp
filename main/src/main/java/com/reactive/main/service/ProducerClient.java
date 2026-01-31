package com.reactive.main.service;

import com.reactive.main.dto.Reading;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.rsocket.RSocketRequester;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
public class ProducerClient {
    private final Flux<Reading> shared;

    public ProducerClient(
            RSocketRequester.Builder builder,
            @Value("${iot.producer.host}") String host,
            @Value("${iot.producer.port}") int port,
            @Value("${iot.producer.route}") String route
            ) {
        RSocketRequester requster = builder.tcp(host, port);

        this.shared = requster.route(route)
                .retrieveFlux(Reading.class)
                .share();
    }

    public Flux<Reading> readings() { return shared; }
}
