package com.reactive.main.service;

import com.reactive.main.dto.Reading;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.rsocket.RSocketRequester;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.util.retry.Retry;

@Service
public class ProducerClient {
    private final Flux<Reading> shared;

    public ProducerClient(
            RSocketRequester.Builder builder,
            @Value("${iot.producer.host}") String host,
            @Value("${iot.producer.port}") int port,
            @Value("${iot.producer.route}") String route
    ) {
        Flux<Reading> source = Flux.usingWhen(
                        Mono.fromSupplier(() -> builder
                                .rsocketConnector(conn -> conn
                                        .keepAlive(Duration.ofSeconds(20), Duration.ofSeconds(90))
                                        .reconnect(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(1))
                                                .maxBackoff(Duration.ofSeconds(10)))
                                )
                                .tcp(host, port)
                        ),
                        requester -> requester.route(route)
                                .retrieveFlux(Reading.class)
                                .doFinally(st -> System.out.println("[RSocket] route terminated: " + st)),
                        requester -> Mono.fromRunnable(requester::dispose),
                        (requester, err) -> Mono.fromRunnable(requester::dispose),
                        requester -> Mono.fromRunnable(requester::dispose)
                )
                .repeatWhen(companion -> companion.delayElements(Duration.ofSeconds(1)))
                .retryWhen(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(1)).maxBackoff(Duration.ofSeconds(10)));


        this.shared = source
                .publish()
                .refCount(1);
    }

    public Flux<Reading> readings() {
        return shared;
    }
}
