package com.paysense.security

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant
import java.util.UUID

enum class Role { VIEWER, INVESTIGATOR, ADMIN }

@Entity
@Table(name = "users")
class UserAccount(
    @Id var id: UUID = UUID.randomUUID(),
    @Column(nullable = false, unique = true) var username: String = "",
    @Column(name = "password_hash", nullable = false) var passwordHash: String = "",
    @Column(nullable = false) @jakarta.persistence.Enumerated(jakarta.persistence.EnumType.STRING) var role: Role = Role.VIEWER,
    @Column(nullable = false) var enabled: Boolean = true,
    @Column(name = "created_at", nullable = false) var createdAt: Instant = Instant.now(),
)

interface UserRepository : JpaRepository<UserAccount, UUID> {
    fun findByUsername(username: String): UserAccount?
}
