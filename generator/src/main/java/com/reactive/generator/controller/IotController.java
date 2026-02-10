package com.reactive.generator.controller;

import com.reactive.generator.model.Sensor;
import com.reactive.generator.model.SensorCreateRequest;
import com.reactive.generator.service.IotEngine;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@CrossOrigin(origins = "*", allowedHeaders = "*")
@RestController
@RequestMapping("/iot")
public class IotController {
    private final IotEngine engine;

    public IotController(IotEngine engine) { this.engine = engine; }

    @PostMapping("/add")
    public Mono<Sensor> add(@RequestBody Mono<SensorCreateRequest> request) {
        return request.flatMap(r ->
                engine.existsDeviceId(r.deviceId())
                        .flatMap(exists -> {
                            if (exists) {
                                return Mono.error(new ResponseStatusException(
                                        HttpStatus.CONFLICT,
                                        "Нельзя создать сенсор: deviceId=" + r.deviceId() + " уже существует"
                                ));
                            }

                            Sensor s = new Sensor(null, r.name(), r.type(), r.deviceId(), r.period(), true);
                            return engine.addSensor(s);
                        })
        );
    }


    @GetMapping("/list")
    public Flux<Sensor> list() {
        return engine.listSensors();
    }

    @DeleteMapping("/{id}")
    public Mono<Void> delete(@PathVariable String id) {
        return engine.deleteSensor(id);
    }

    public record AdjustResponse(String sensorId, double bias) { }

    @PostMapping("/{id}/adjust")
    public Mono<AdjustResponse> adjust(@PathVariable String id, @RequestParam double delta) {
        return engine.listSensors()
                .filter(s -> id.equals(s.id()))
                .next()
                .switchIfEmpty(Mono.error(new ResponseStatusException(HttpStatus.NOT_FOUND, "Sensor not found: " + id)))
                .then(engine.adjustBias(id, delta))
                .map(b -> new AdjustResponse(id, b));
    }
}
