# Firestore clock-skew safety

[English](firestore-clock-skew.md) | [日本語](firestore-clock-skew.ja.md)

`FirestoreUsageStore` intentionally uses the application host clock for lease timestamps. It does not claim Redis-style authoritative server-time semantics.

The v1-supported Firestore deployment profile therefore requires **bounded, synchronized application clocks**. If a deployment cannot establish that bound, use a store with an authoritative time source (for example Redis or Durable Objects) rather than treating Firestore lease recovery as proven safe.

## Exact expiry rule

A reservation with stored expiry `expiresAtMs` is considered expired only when:

```text
expiresAtMs <= recoveryHostNow - expiryGraceMs
```

or equivalently:

```text
recoveryHostNow >= expiresAtMs + expiryGraceMs
```

This means `expiryGraceMs` protects against a recovery host whose clock is ahead of the host that last wrote `expiresAtMs`.

For the supported envelope, configure:

```text
expiryGraceMs >= maxExpectedPositiveClockLead + clockMeasurementMargin
```

where `maxExpectedPositiveClockLead` is the largest expected positive difference between any host that may perform expiry/recovery and any host that may create or renew a lease.

If every host is maintained within `±E` of a common time source, the worst-case pairwise lead can be approximately `2E`; size the grace from the **pairwise** bound, not merely the per-host bound.

## Renewal from another instance

`renew()` computes the new timestamp from the renewing host's clock:

```text
newExpiresAtMs = renewingHostNow + ttlMs
```

A slow renewing host can therefore produce a timestamp lower than a timestamp previously written by a faster host. Within the supported skew envelope this does not cause premature recovery: the configured grace absorbs the recovery host's positive lead over the renewing host.

This is why clock synchronization is a deployment requirement rather than an optional performance recommendation.

## TTL, network latency, and scheduling

`expiryGraceMs` is a clock-skew safety margin. It is **not** a substitute for a sufficiently long lease TTL.

The lease timestamp is calculated on an application host before the Firestore transaction acknowledgement returns. Transaction retries, network latency, event-loop delay, and heartbeat scheduling therefore consume part of the nominal TTL.

Choose `ttlMs` so that it comfortably exceeds the deployment's worst expected combination of:

- Firestore transaction/network latency and retry time;
- heartbeat/renewal scheduling interval;
- event-loop or worker scheduling jitter;
- operational margin for transient delays.

Then size `expiryGraceMs` separately from the maximum expected pairwise clock lead.

## Conservative failure boundary

Within the documented clock-skew envelope:

- pending reservations are not released before their writer-relative lease lifetime plus the configured skew protection;
- cost-liable reservations remain fully charged when they expire;
- recovery from another process does not create additional admission capacity early.

Outside that envelope, the adapter cannot detect arbitrary host-clock error from Firestore data alone. **An environment with unknown or unbounded clock skew is outside the v1-supported Firestore deployment profile.** Do not compensate by lowering the grace or by treating uncertain recovery as authoritative evidence of safe capacity.

If clock-health monitoring shows that the configured bound may be violated, the conservative operational response is to stop relying on Firestore lease expiry/recovery until clock synchronization is restored, or move enforcement to a backend with an authoritative time source. Do not turn uncertainty into unmetered allow.

## Deterministic evidence

The Firestore package includes multi-instance tests with independent clocks that cover:

- a recovery host running ahead of the producer but still within `expiryGraceMs`;
- a renewal performed by a slower host and recovery from another host;
- cost-liable expiry across skewed instances with full reserved-unit retention.

These tests prove the documented bounded-skew contract. They intentionally do not claim safety for arbitrary or unbounded host-clock divergence.
