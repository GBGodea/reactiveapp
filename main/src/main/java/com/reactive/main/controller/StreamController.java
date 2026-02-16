package com.reactive.main.controller;

import com.reactive.main.dto.Reading;
import com.reactive.main.service.ProducerClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamController {

    private final ProducerClient client;

    public StreamController(ProducerClient client) {
        this.client = client;
    }

    @GetMapping(value = "/api/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<Reading>> stream(
            @RequestParam(name = "devices", required = false) String devicesExpr
    ) {
        Predicate<Reading> deviceFilter = buildDeviceFilter(devicesExpr);

        Flux<ServerSentEvent<Reading>> data = client.readings()
                // если SSE клиент медленный — не накапливаем всё
                .onBackpressureLatest()
                .filter(deviceFilter)
                .map(r -> ServerSentEvent.builder(r).build());

        Flux<ServerSentEvent<Reading>> heartbeat = Flux.interval(Duration.ofSeconds(10))
                .map(i -> ServerSentEvent.<Reading>builder().comment("ka").build());

        return Flux.merge(data, heartbeat);
    }

    private static Predicate<Reading> buildDeviceFilter(String expr) {
        List<IntRange> ranges = parseRanges(expr);
        if (ranges.isEmpty()) {
            // если фильтр не задан — отдаём всё (можно поменять на "ничего", если хочешь)
            return r -> true;
        }
        return r -> {
            String deviceId = r.deviceId();
            if (deviceId == null) return false;
            final int v;
            try {
                v = Integer.parseInt(deviceId.trim());
            } catch (Exception e) {
                return false;
            }
            for (IntRange range : ranges) {
                if (v >= range.a && v <= range.b) return true;
            }
            return false;
        };
    }

    private static List<IntRange> parseRanges(String expr) {
        if (expr == null) return List.of();
        String s = expr.trim();
        if (s.isEmpty()) return List.of();

        String[] parts = s.split(",");
        List<IntRange> ranges = new ArrayList<>();

        for (String raw : parts) {
            String p = raw.trim();
            if (p.isEmpty()) continue;

            int dash = p.indexOf('-');
            if (dash >= 0) {
                String a0 = p.substring(0, dash).trim();
                String b0 = p.substring(dash + 1).trim();
                try {
                    int a = Integer.parseInt(a0);
                    int b = Integer.parseInt(b0);
                    int lo = Math.min(a, b);
                    int hi = Math.max(a, b);
                    ranges.add(new IntRange(lo, hi));
                } catch (Exception ignored) { }
            } else {
                try {
                    int v = Integer.parseInt(p);
                    ranges.add(new IntRange(v, v));
                } catch (Exception ignored) { }
            }
        }

        if (ranges.isEmpty()) return ranges;

        // merge overlapping/adjacent
        ranges.sort(Comparator.comparingInt(r -> r.a));
        List<IntRange> merged = new ArrayList<>();
        for (IntRange r : ranges) {
            if (merged.isEmpty()) merged.add(r);
            else {
                IntRange last = merged.get(merged.size() - 1);
                if (r.a <= last.b + 1) last.b = Math.max(last.b, r.b);
                else merged.add(r);
            }
        }
        return merged;
    }

    private static final class IntRange {
        final int a;
        int b;
        IntRange(int a, int b) { this.a = a; this.b = b; }
    }
}
