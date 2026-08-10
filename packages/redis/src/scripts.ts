export const RESERVE_SCRIPT = String.raw`
local units = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local reservationId = ARGV[3]
local operationKey = ARGV[4]
local cleanupLimit = tonumber(ARGV[5])
local idempotencyTtlMs = tonumber(ARGV[6])
local budgets = cjson.decode(ARGV[7])

local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

local function subtractUsed(budgetHashes, amount)
  if amount <= 0 then return end
  for _, budgetHash in ipairs(budgetHashes) do
    local nextUsed = redis.call('HINCRBY', KEYS[1], budgetHash, -amount)
    if tonumber(nextUsed) <= 0 then
      redis.call('HDEL', KEYS[1], budgetHash)
    end
  end
end

-- One global lease index avoids partial cleanup when a reservation participates
-- in several budgets. Every expired reservation is recovered exactly once.
local expiredReservations = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, cleanupLimit)
for _, rid in ipairs(expiredReservations) do
  local raw = redis.call('HGET', KEYS[3], rid)
  if raw then
    local record = cjson.decode(raw)
    if record.state == 'pending' then
      subtractUsed(record.budgetHashes, tonumber(record.reservedUnits))
      redis.call('HDEL', KEYS[4], record.operationKey)
      redis.call('HDEL', KEYS[3], rid)
    elseif record.state == 'liable' then
      record.state = 'settled'
      record.actualUnits = tonumber(record.reservedUnits)
      record.outcome = 'lease_expired_after_execution_started'
      redis.call('HSET', KEYS[3], rid, cjson.encode(record))
      redis.call('ZADD', KEYS[5], now + idempotencyTtlMs, record.operationKey)
    end
  end
  redis.call('ZREM', KEYS[2], rid)
end

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

-- First pass is read-only. If any budget denies, nothing is reserved.
local remainingByHash = {}
for _, budget in ipairs(budgets) do
  local used = tonumber(redis.call('HGET', KEYS[1], budget.hash) or '0')
  local remaining = tonumber(budget.limit) - used
  if remaining < 0 then remaining = 0 end
  remainingByHash[budget.hash] = remaining
  if units > remaining then
    return { 'quota_exceeded', budget.hash, tostring(remaining) }
  end
end

-- Second pass applies the reservation to every budget in the same Lua script.
local budgetHashes = {}
local reply = { 'accepted' }
local expiresAt = now + ttlMs
table.insert(reply, tostring(expiresAt))
for _, budget in ipairs(budgets) do
  table.insert(budgetHashes, budget.hash)
  if units > 0 then
    redis.call('HINCRBY', KEYS[1], budget.hash, units)
  end
  table.insert(reply, budget.hash)
  table.insert(reply, tostring(remainingByHash[budget.hash] - units))
end

local record = cjson.encode({
  state = 'pending',
  operationKey = operationKey,
  reservedUnits = units,
  expiresAt = expiresAt,
  budgetHashes = budgetHashes
})
redis.call('HSET', KEYS[3], reservationId, record)
redis.call('HSET', KEYS[4], operationKey, reservationId)
redis.call('ZADD', KEYS[2], expiresAt, reservationId)

return reply
`;

export const MARK_LIABLE_SCRIPT = String.raw`
local reservationId = ARGV[1]
local idempotencyTtlMs = tonumber(ARGV[2])

local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

local function subtractUsed(budgetHashes, amount)
  if amount <= 0 then return end
  for _, budgetHash in ipairs(budgetHashes) do
    local nextUsed = redis.call('HINCRBY', KEYS[1], budgetHash, -amount)
    if tonumber(nextUsed) <= 0 then redis.call('HDEL', KEYS[1], budgetHash) end
  end
end

local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end

local record = cjson.decode(raw)
if record.state == 'settled' then return { 'not_pending' } end

if tonumber(record.expiresAt) <= now then
  if record.state == 'pending' then
    subtractUsed(record.budgetHashes, tonumber(record.reservedUnits))
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  elseif record.state == 'liable' then
    record.state = 'settled'
    record.actualUnits = tonumber(record.reservedUnits)
    record.outcome = 'lease_expired_after_execution_started'
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], now + idempotencyTtlMs, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return { 'expired' }
end

if record.state == 'pending' then
  record.state = 'liable'
  redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
elseif record.state ~= 'liable' then
  return { 'not_pending' }
end

return { 'marked', tostring(record.expiresAt) }
`;

export const RENEW_SCRIPT = String.raw`
local ttlMs = tonumber(ARGV[1])
local reservationId = ARGV[2]
local idempotencyTtlMs = tonumber(ARGV[3])

local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

local function subtractUsed(budgetHashes, amount)
  if amount <= 0 then return end
  for _, budgetHash in ipairs(budgetHashes) do
    local nextUsed = redis.call('HINCRBY', KEYS[1], budgetHash, -amount)
    if tonumber(nextUsed) <= 0 then redis.call('HDEL', KEYS[1], budgetHash) end
  end
end

local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end

local record = cjson.decode(raw)
if record.state == 'settled' then return { 'not_pending' } end

if tonumber(record.expiresAt) <= now then
  if record.state == 'pending' then
    subtractUsed(record.budgetHashes, tonumber(record.reservedUnits))
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  elseif record.state == 'liable' then
    record.state = 'settled'
    record.actualUnits = tonumber(record.reservedUnits)
    record.outcome = 'lease_expired_after_execution_started'
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], now + idempotencyTtlMs, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return { 'expired' }
end

if record.state ~= 'pending' and record.state ~= 'liable' then return { 'not_pending' } end

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
local idempotencyTtlMs = tonumber(ARGV[4])

local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

local function subtractUsed(budgetHashes, amount)
  if amount <= 0 then return end
  for _, budgetHash in ipairs(budgetHashes) do
    local nextUsed = redis.call('HINCRBY', KEYS[1], budgetHash, -amount)
    if tonumber(nextUsed) <= 0 then redis.call('HDEL', KEYS[1], budgetHash) end
  end
end

local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end

local record = cjson.decode(raw)
local reservedUnits = tonumber(record.reservedUnits)

if record.state == 'settled' then
  if tonumber(record.actualUnits) == actualUnits and record.outcome == outcome then
    return { 'idempotent', tostring(reservedUnits), tostring(actualUnits), tostring(reservedUnits - actualUnits) }
  end
  return { 'conflict' }
end

if record.state ~= 'pending' and record.state ~= 'liable' then return { 'not_pending' } end

if tonumber(record.expiresAt) <= now then
  if record.state == 'pending' then
    subtractUsed(record.budgetHashes, reservedUnits)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  else
    record.state = 'settled'
    record.actualUnits = reservedUnits
    record.outcome = 'lease_expired_after_execution_started'
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], now + idempotencyTtlMs, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return { 'expired' }
end

if actualUnits > reservedUnits then return { 'invalid_units' } end

local released = reservedUnits - actualUnits
subtractUsed(record.budgetHashes, released)

record.state = 'settled'
record.actualUnits = actualUnits
record.outcome = outcome
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZADD', KEYS[5], now + idempotencyTtlMs, record.operationKey)

return { 'settled', tostring(reservedUnits), tostring(actualUnits), tostring(released) }
`;
