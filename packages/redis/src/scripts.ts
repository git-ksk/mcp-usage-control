export const RESERVE_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local units = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local expiresAt = tonumber(ARGV[4])
local reservationId = ARGV[5]
local operationKey = ARGV[6]
local cleanupLimit = tonumber(ARGV[7])

-- Reclaim expired pending reservations for this budget before admitting new work.
local expiredReservations = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, cleanupLimit)
for _, rid in ipairs(expiredReservations) do
  local raw = redis.call('HGET', KEYS[3], rid)
  if raw then
    local record = cjson.decode(raw)
    if record.state == 'pending' then
      local used = tonumber(redis.call('GET', KEYS[1]) or '0')
      local nextUsed = used - tonumber(record.reservedUnits)
      if nextUsed <= 0 then
        redis.call('DEL', KEYS[1])
      else
        redis.call('SET', KEYS[1], tostring(nextUsed))
      end
      redis.call('HDEL', KEYS[4], record.operationKey)
      redis.call('HDEL', KEYS[3], rid)
    end
  end
  redis.call('ZREM', KEYS[2], rid)
end

-- Bound settled idempotency state. This cleanup is global but batch-limited.
local expiredOperations = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', now, 'LIMIT', 0, cleanupLimit)
for _, op in ipairs(expiredOperations) do
  local rid = redis.call('HGET', KEYS[4], op)
  if rid then
    local raw = redis.call('HGET', KEYS[3], rid)
    if raw then
      local record = cjson.decode(raw)
      if record.state == 'settled' then
        redis.call('HDEL', KEYS[3], rid)
      end
    end
    redis.call('HDEL', KEYS[4], op)
  end
  redis.call('ZREM', KEYS[5], op)
end

if redis.call('HEXISTS', KEYS[4], operationKey) == 1 then
  return { 'duplicate_operation' }
end

local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local remaining = limit - used
if remaining < 0 then remaining = 0 end

if units > remaining then
  return { 'quota_exceeded', tostring(remaining) }
end

local nextUsed = used + units
if nextUsed == 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], tostring(nextUsed))
end

local record = cjson.encode({
  state = 'pending',
  operationKey = operationKey,
  reservedUnits = units,
  expiresAt = expiresAt
})
redis.call('HSET', KEYS[3], reservationId, record)
redis.call('HSET', KEYS[4], operationKey, reservationId)
redis.call('ZADD', KEYS[2], expiresAt, reservationId)

return { 'accepted', tostring(remaining - units) }
`;

export const RENEW_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local reservationId = ARGV[3]

local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then
  return { 'not_found' }
end

local record = cjson.decode(raw)
if record.state ~= 'pending' then
  return { 'not_pending' }
end

if tonumber(record.expiresAt) <= now then
  local used = tonumber(redis.call('GET', KEYS[1]) or '0')
  local nextUsed = used - tonumber(record.reservedUnits)
  if nextUsed <= 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('SET', KEYS[1], tostring(nextUsed))
  end
  redis.call('ZREM', KEYS[2], reservationId)
  redis.call('HDEL', KEYS[4], record.operationKey)
  redis.call('HDEL', KEYS[3], reservationId)
  return { 'expired' }
end

local expiresAt = now + ttlMs
record.expiresAt = expiresAt
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
redis.call('ZADD', KEYS[2], expiresAt, reservationId)
return { 'renewed', tostring(expiresAt) }
`;

export const SETTLE_SCRIPT = String.raw`
local reservationId = ARGV[1]
local actualUnits = tonumber(ARGV[2])
local outcome = ARGV[3]
local tombstoneExpiresAt = tonumber(ARGV[4])

local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then
  return { 'not_found' }
end

local record = cjson.decode(raw)
local reservedUnits = tonumber(record.reservedUnits)

if actualUnits > reservedUnits then
  return { 'invalid_units' }
end

if record.state == 'settled' then
  if tonumber(record.actualUnits) == actualUnits and record.outcome == outcome then
    return {
      'idempotent',
      tostring(reservedUnits),
      tostring(actualUnits),
      tostring(reservedUnits - actualUnits)
    }
  end
  return { 'conflict' }
end

if record.state ~= 'pending' then
  return { 'not_pending' }
end

local released = reservedUnits - actualUnits
if released > 0 then
  local used = tonumber(redis.call('GET', KEYS[1]) or '0')
  local nextUsed = used - released
  if nextUsed <= 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('SET', KEYS[1], tostring(nextUsed))
  end
end

record.state = 'settled'
record.actualUnits = actualUnits
record.outcome = outcome
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)

return {
  'settled',
  tostring(reservedUnits),
  tostring(actualUnits),
  tostring(released)
}
`;
