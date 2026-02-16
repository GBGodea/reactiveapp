package com.reactive.generator.controller;

import com.reactive.generator.model.Reading;
import com.reactive.generator.service.IotEngine;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
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

    /**
     * Readings stream with server-side device filter.
     * devicesExpr examples: "1", "1,3,10", "1-100", "1-10,200-250"
     * Empty/blank => everything.
     */
    @MessageMapping("iot.readingsByDevices")
    public Flux<Reading> readingsByDevices(String devicesExpr) {
        Predicate<Reading> filter = buildDeviceFilter(devicesExpr);
        return engine.readings().filter(filter);
    }

    private static Predicate<Reading> buildDeviceFilter(String expr) {
        List<IntRange> ranges = parseRanges(expr);
        if (ranges.isEmpty()) return r -> true;

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
