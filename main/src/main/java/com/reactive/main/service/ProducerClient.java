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

    private final RSocketRequester.Builder builder;
    private final String host;
    private final int port;
    private final String defaultRoute;

    private final Flux<Reading> shared;

    public ProducerClient(
            RSocketRequester.Builder builder,
            @Value("${iot.producer.host}") String host,
            @Value("${iot.producer.port}") int port,
            @Value("${iot.producer.route}") String route
    ) {
        this.builder = builder;
        this.host = host;
        this.port = port;
        this.defaultRoute = route;

        Flux<Reading> source = connectAndRetrieve(defaultRoute, null);

        this.shared = source
                .publish()
                .refCount(1);
    }

    public Flux<Reading> readings() {
        return shared;
    }

    public Flux<Reading> readingsByDevices(String devicesExpr) {
        String expr = (devicesExpr == null) ? "" : devicesExpr;
        return connectAndRetrieve("iot.readingsByDevices", expr);
    }

    private Flux<Reading> connectAndRetrieve(String route, Object data) {
        return Flux.usingWhen(
                        Mono.fromSupplier(() -> builder
                                .rsocketConnector(conn -> conn
                                        .keepAlive(Duration.ofSeconds(20), Duration.ofSeconds(90))
                                        .reconnect(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(1))
                                                .maxBackoff(Duration.ofSeconds(10)))
                                )
                                .tcp(host, port)
                        ),
                        requester -> {
                            if (data == null) {
                                return requester.route(route).retrieveFlux(Reading.class);
                            }
                            return requester.route(route).data(data).retrieveFlux(Reading.class);
                        },
                        requester -> Mono.fromRunnable(requester::dispose),
                        (requester, err) -> Mono.fromRunnable(requester::dispose),
                        requester -> Mono.fromRunnable(requester::dispose)
                )
                .repeatWhen(companion -> companion.delayElements(Duration.ofSeconds(1)))
                .retryWhen(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(1)).maxBackoff(Duration.ofSeconds(10)));
    }
}
