package com.reactive.generator.repository;

import org.springframework.data.mongodb.repository.ReactiveMongoRepository;
import com.reactive.generator.model.ReadingEntity;

public interface ReadingRepository extends ReactiveMongoRepository<ReadingEntity, String> {
}
