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

    // Добавление нового сенсора(термометр, влажность, движение)
    @PostMapping("/add")
    public Mono<Sensor> add(@RequestBody Mono<SensorCreateRequest> request) {
        return request
                .map(r -> new Sensor(null, r.name(), r.type(), r.deviceId(), r.period(), true))
                .flatMap(engine::addSensor);
    }

    // Позволяет получить метаданные сенсоров(имя, deviceId и т.д.)
    @GetMapping("/list")
    public Flux<Sensor> list() {
        return engine.listSensors();
    }

    // Удаление сенсора(Удаляет поток сенсора и возвращает void)
    @DeleteMapping("/{id}")
    public Mono<Void> delete(@PathVariable String id) {
        return engine.deleteSensor(id);
    }

    // Обёртка для возврата ответа
    public record AdjustResponse(String sensorId, double bias) { }

    // Обновление значения сенсора
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
