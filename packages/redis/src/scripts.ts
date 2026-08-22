const COMMON = String.raw`
local MAX_SAFE_INTEGER = 9007199254740991

local function safeTimeAdd(base, delta)
  if not base or not delta or base < 0 or delta <= 0 then return nil end
  if base > MAX_SAFE_INTEGER or delta > (MAX_SAFE_INTEGER - base) then return nil end
  return base + delta
end

local function subtractUsed(budgetHashes, amount)
  if amount <= 0 then return end
  for _, budgetHash in ipairs(budgetHashes) do
    local nextUsed = redis.call('HINCRBY', KEYS[1], budgetHash, -amount)
    if tonumber(nextUsed) <= 0 then redis.call('HDEL', KEYS[1], budgetHash) end
  end
end

local function isVector(record)
  return record.mode == 'vector'
end

local function vectorBudgetCount(record)
  local count = 0
  for _, dimension in ipairs(record.dimensions or {}) do
    count = count + #(dimension.budgetHashes or {})
  end
  return count
end

local function releaseRecord(record)
  if isVector(record) then
    for _, dimension in ipairs(record.dimensions or {}) do
      subtractUsed(dimension.budgetHashes, tonumber(dimension.reservedUnits))
    end
    return
  end
  subtractUsed(record.budgetHashes, tonumber(record.reservedUnits))
end

local function retainLiable(record)
  record.state = 'settled'
  record.outcome = 'lease_expired_after_execution_started'
  if isVector(record) then
    local actual = {}
    for _, dimension in ipairs(record.dimensions or {}) do
      table.insert(actual, { hash = dimension.hash, actualUnits = tonumber(dimension.reservedUnits) })
    end
    record.actualByDimensions = actual
  else
    record.actualUnits = tonumber(record.reservedUnits)
  end
end

local function directExpiryReply(record, expiredState)
  if isVector(record) then
    return { 'expired_vector', expiredState, tostring(#(record.dimensions or {})), tostring(vectorBudgetCount(record)) }
  end
  return { 'expired', expiredState, tostring(tonumber(record.reservedUnits)) }
end
`;

const CLEANUP = String.raw`
local recoveredPendingCount = 0
local recoveredPendingUnits = 0
local recoveredLiableCount = 0
local recoveredLiableUnits = 0
local recoveredVectorPendingCount = 0
local recoveredVectorLiableCount = 0

local function withRecovery(reply)
  table.insert(reply, 'recovery')
  table.insert(reply, tostring(recoveredPendingCount))
  table.insert(reply, tostring(recoveredPendingUnits))
  table.insert(reply, tostring(recoveredLiableCount))
  table.insert(reply, tostring(recoveredLiableUnits))
  table.insert(reply, tostring(recoveredVectorPendingCount))
  table.insert(reply, tostring(recoveredVectorLiableCount))
  return reply
end

local expiredReservations = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, cleanupLimit)
for _, rid in ipairs(expiredReservations) do
  local raw = redis.call('HGET', KEYS[3], rid)
  if raw then
    local record = cjson.decode(raw)
    if record.state == 'pending' then
      releaseRecord(record)
      redis.call('HDEL', KEYS[4], record.operationKey)
      redis.call('HDEL', KEYS[3], rid)
      if isVector(record) then
        recoveredVectorPendingCount = recoveredVectorPendingCount + 1
      else
        recoveredPendingCount = recoveredPendingCount + 1
        recoveredPendingUnits = recoveredPendingUnits + tonumber(record.reservedUnits)
      end
    elseif record.state == 'liable' then
      retainLiable(record)
      redis.call('HSET', KEYS[3], rid, cjson.encode(record))
      redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
      if isVector(record) then
        recoveredVectorLiableCount = recoveredVectorLiableCount + 1
      else
        recoveredLiableCount = recoveredLiableCount + 1
        recoveredLiableUnits = recoveredLiableUnits + tonumber(record.reservedUnits)
      end
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
      if record.state == 'settled' then redis.call('HDEL', KEYS[3], rid) end
    end
    redis.call('HDEL', KEYS[4], op)
  end
  redis.call('ZREM', KEYS[5], op)
end
`;

export const RESERVE_SCRIPT = String.raw`
local units = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local reservationId = ARGV[3]
local operationKey = ARGV[4]
local cleanupLimit = tonumber(ARGV[5])
local idempotencyTtlMs = tonumber(ARGV[6])
local budgets = cjson.decode(ARGV[7])
local growthCursor = ARGV[8]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local expiresAt = safeTimeAdd(now, ttlMs)
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not expiresAt or not tombstoneExpiresAt then return { 'invalid_time' } end
${CLEANUP}
if redis.call('HEXISTS', KEYS[4], operationKey) == 1 then return withRecovery({ 'duplicate_operation' }) end
local remainingByHash = {}
for _, budget in ipairs(budgets) do
  local used = tonumber(redis.call('HGET', KEYS[1], budget.hash) or '0')
  local remaining = tonumber(budget.limit) - used
  if remaining < 0 then remaining = 0 end
  remainingByHash[budget.hash] = remaining
  if units > remaining then return withRecovery({ 'quota_exceeded', budget.hash, tostring(remaining) }) end
end
local budgetHashes = {}
local reply = { 'accepted' }
table.insert(reply, tostring(expiresAt))
for _, budget in ipairs(budgets) do
  table.insert(budgetHashes, budget.hash)
  if units > 0 then redis.call('HINCRBY', KEYS[1], budget.hash, units) end
  table.insert(reply, budget.hash)
  table.insert(reply, tostring(remainingByHash[budget.hash] - units))
end
local record = cjson.encode({
  state = 'pending', operationKey = operationKey, reservedUnits = units,
  expiresAt = expiresAt, budgetHashes = budgetHashes, growthCursor = growthCursor
})
redis.call('HSET', KEYS[3], reservationId, record)
redis.call('HSET', KEYS[4], operationKey, reservationId)
redis.call('ZADD', KEYS[2], expiresAt, reservationId)
return withRecovery(reply)
`;

export const RESERVE_VECTOR_SCRIPT = String.raw`
local ttlMs = tonumber(ARGV[1])
local reservationId = ARGV[2]
local operationKey = ARGV[3]
local cleanupLimit = tonumber(ARGV[4])
local idempotencyTtlMs = tonumber(ARGV[5])
local dimensions = cjson.decode(ARGV[6])
local growthCursor = ARGV[7]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local expiresAt = safeTimeAdd(now, ttlMs)
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not expiresAt or not tombstoneExpiresAt then return { 'invalid_time' } end
${CLEANUP}
if redis.call('HEXISTS', KEYS[4], operationKey) == 1 then return withRecovery({ 'duplicate_operation' }) end
local balances = {}
for _, dimension in ipairs(dimensions) do
  for _, budget in ipairs(dimension.budgets) do
    local used = tonumber(redis.call('HGET', KEYS[1], budget.hash) or '0')
    local remaining = tonumber(budget.limit) - used
    if remaining < 0 then remaining = 0 end
    table.insert(balances, { dimensionHash = dimension.hash, budgetHash = budget.hash, remaining = remaining - tonumber(dimension.units) })
    if tonumber(dimension.units) > remaining then
      return withRecovery({ 'quota_exceeded', dimension.hash, budget.hash, tostring(remaining) })
    end
  end
end
local storedDimensions = {}
for _, dimension in ipairs(dimensions) do
  local hashes = {}
  for _, budget in ipairs(dimension.budgets) do
    table.insert(hashes, budget.hash)
    if tonumber(dimension.units) > 0 then redis.call('HINCRBY', KEYS[1], budget.hash, tonumber(dimension.units)) end
  end
  table.insert(storedDimensions, { hash = dimension.hash, reservedUnits = tonumber(dimension.units), budgetHashes = hashes })
end
local record = cjson.encode({
  mode = 'vector', state = 'pending', operationKey = operationKey,
  dimensions = storedDimensions, expiresAt = expiresAt, growthCursor = growthCursor
})
redis.call('HSET', KEYS[3], reservationId, record)
redis.call('HSET', KEYS[4], operationKey, reservationId)
redis.call('ZADD', KEYS[2], expiresAt, reservationId)
return withRecovery({ 'accepted', tostring(expiresAt), cjson.encode(balances) })
`;

export const MARK_LIABLE_SCRIPT = String.raw`
local reservationId = ARGV[1]
local idempotencyTtlMs = tonumber(ARGV[2])
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if record.state == 'settled' then return { 'not_pending' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  elseif record.state == 'liable' then
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
if record.state == 'pending' then
  record.state = 'liable'
  redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
elseif record.state ~= 'liable' then return { 'not_pending' } end
return { 'marked', tostring(record.expiresAt) }
`;

export const RENEW_SCRIPT = String.raw`
local ttlMs = tonumber(ARGV[1])
local reservationId = ARGV[2]
local idempotencyTtlMs = tonumber(ARGV[3])
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local expiresAt = safeTimeAdd(now, ttlMs)
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not expiresAt or not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if record.state == 'settled' then return { 'not_pending' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  elseif record.state == 'liable' then
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
if record.state ~= 'pending' and record.state ~= 'liable' then return { 'not_pending' } end
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
${COMMON}
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if isVector(record) then return { 'mode_mismatch' } end
local reservedUnits = tonumber(record.reservedUnits)
if record.state == 'settled' then
  if tonumber(record.actualUnits) == actualUnits and record.outcome == outcome then
    return { 'idempotent', tostring(reservedUnits), tostring(actualUnits), tostring(reservedUnits - actualUnits) }
  end
  return { 'conflict' }
end
if record.state ~= 'pending' and record.state ~= 'liable' then return { 'not_pending' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  else
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
if actualUnits > reservedUnits then return { 'invalid_units' } end
local released = reservedUnits - actualUnits
subtractUsed(record.budgetHashes, released)
record.state = 'settled'
record.actualUnits = actualUnits
record.outcome = outcome
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
return { 'settled', tostring(reservedUnits), tostring(actualUnits), tostring(released) }
`;

export const SETTLE_VECTOR_SCRIPT = String.raw`
local reservationId = ARGV[1]
local actuals = cjson.decode(ARGV[2])
local outcome = ARGV[3]
local idempotencyTtlMs = tonumber(ARGV[4])
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if not isVector(record) then return { 'mode_mismatch' } end
local function sameActuals(left, right)
  if not left or #left ~= #right then return false end
  for index, item in ipairs(right) do
    if left[index].hash ~= item.hash or tonumber(left[index].actualUnits) ~= tonumber(item.actualUnits) then return false end
  end
  return true
end
local function settlementJson()
  local result = {}
  for index, dimension in ipairs(record.dimensions) do
    local actual = tonumber(actuals[index].actualUnits)
    local reserved = tonumber(dimension.reservedUnits)
    table.insert(result, { hash = dimension.hash, reservedUnits = reserved, actualUnits = actual, releasedUnits = reserved - actual })
  end
  return cjson.encode(result)
end
if record.state == 'settled' then
  if record.outcome == outcome and sameActuals(record.actualByDimensions, actuals) then return { 'idempotent', settlementJson() } end
  return { 'conflict' }
end
if record.state ~= 'pending' and record.state ~= 'liable' then return { 'not_pending' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  else
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
if #actuals ~= #record.dimensions then return { 'dimension_mismatch' } end
for index, actual in ipairs(actuals) do
  local dimension = record.dimensions[index]
  if actual.hash ~= dimension.hash then return { 'dimension_mismatch' } end
  if tonumber(actual.actualUnits) > tonumber(dimension.reservedUnits) then return { 'invalid_units' } end
end
for index, dimension in ipairs(record.dimensions) do
  local released = tonumber(dimension.reservedUnits) - tonumber(actuals[index].actualUnits)
  subtractUsed(dimension.budgetHashes, released)
end
record.state = 'settled'
record.actualByDimensions = actuals
record.outcome = outcome
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
return { 'settled', settlementJson() }
`;

export const GROW_SCRIPT = String.raw`
local reservationId = ARGV[1]
local incrementHash = ARGV[2]
local expectedGrowthCursor = ARGV[3]
local additionalUnits = tonumber(ARGV[4])
local idempotencyTtlMs = tonumber(ARGV[5])
local budgets = cjson.decode(ARGV[6])
local fingerprint = ARGV[7]
local nextGrowthCursor = ARGV[8]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if isVector(record) then return { 'mode_mismatch' } end
local reservedUnits = tonumber(record.reservedUnits)
if record.state == 'settled' or (record.state ~= 'pending' and record.state ~= 'liable') then return { 'terminal' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  else
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
local lastGrowth = record.lastGrowth
if lastGrowth and lastGrowth.incrementHash == incrementHash then
  if lastGrowth.expectedGrowthCursor ~= expectedGrowthCursor or lastGrowth.fingerprint ~= fingerprint then return { 'conflict' } end
  if lastGrowth.accepted == true then
    return { 'accepted_replay', tostring(lastGrowth.previousReservedUnits), tostring(lastGrowth.reservedUnits), lastGrowth.nextGrowthCursor, cjson.encode(lastGrowth.remainingByHashes) }
  end
  return { 'quota_replay', lastGrowth.nextGrowthCursor, lastGrowth.limitingBudgetHash, tostring(lastGrowth.remaining) }
end
if not record.growthCursor then return { 'not_supported' } end
if record.growthCursor ~= expectedGrowthCursor then return { 'stale_cursor' } end
if #record.budgetHashes ~= #budgets then return { 'budget_mismatch' } end
for index, budget in ipairs(budgets) do if record.budgetHashes[index] ~= budget.hash then return { 'budget_mismatch' } end end
local remainingByHashes = {}
local limitingBudgetHash = nil
local limitingRemaining = nil
for _, budget in ipairs(budgets) do
  local used = tonumber(redis.call('HGET', KEYS[1], budget.hash) or '0')
  local remaining = tonumber(budget.limit) - used
  if remaining < 0 then remaining = 0 end
  table.insert(remainingByHashes, { hash = budget.hash, remaining = remaining - additionalUnits })
  if not limitingBudgetHash and additionalUnits > remaining then limitingBudgetHash = budget.hash; limitingRemaining = remaining end
end
if limitingBudgetHash then
  record.growthCursor = nextGrowthCursor
  record.lastGrowth = {
    accepted = false, incrementHash = incrementHash, expectedGrowthCursor = expectedGrowthCursor,
    fingerprint = fingerprint, nextGrowthCursor = nextGrowthCursor,
    limitingBudgetHash = limitingBudgetHash, remaining = limitingRemaining
  }
  redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
  return { 'quota_exceeded', nextGrowthCursor, limitingBudgetHash, tostring(limitingRemaining) }
end
local previousReservedUnits = reservedUnits
local nextReservedUnits = reservedUnits + additionalUnits
for _, budget in ipairs(budgets) do redis.call('HINCRBY', KEYS[1], budget.hash, additionalUnits) end
record.reservedUnits = nextReservedUnits
record.growthCursor = nextGrowthCursor
record.lastGrowth = {
  accepted = true, incrementHash = incrementHash, expectedGrowthCursor = expectedGrowthCursor,
  fingerprint = fingerprint, nextGrowthCursor = nextGrowthCursor,
  previousReservedUnits = previousReservedUnits, reservedUnits = nextReservedUnits,
  remainingByHashes = remainingByHashes
}
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
return { 'accepted', tostring(previousReservedUnits), tostring(nextReservedUnits), nextGrowthCursor, cjson.encode(remainingByHashes) }
`;

export const GROW_VECTOR_SCRIPT = String.raw`
local reservationId = ARGV[1]
local incrementHash = ARGV[2]
local expectedGrowthCursor = ARGV[3]
local idempotencyTtlMs = tonumber(ARGV[4])
local dimensions = cjson.decode(ARGV[5])
local fingerprint = ARGV[6]
local nextGrowthCursor = ARGV[7]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
${COMMON}
local tombstoneExpiresAt = safeTimeAdd(now, idempotencyTtlMs)
if not tombstoneExpiresAt then return { 'invalid_time' } end
local raw = redis.call('HGET', KEYS[3], reservationId)
if not raw then return { 'not_found' } end
local record = cjson.decode(raw)
if not isVector(record) then return { 'mode_mismatch' } end
if record.state == 'settled' or (record.state ~= 'pending' and record.state ~= 'liable') then return { 'terminal' } end
if tonumber(record.expiresAt) <= now then
  local expiredState = record.state
  if record.state == 'pending' then
    releaseRecord(record)
    redis.call('HDEL', KEYS[4], record.operationKey)
    redis.call('HDEL', KEYS[3], reservationId)
  else
    retainLiable(record)
    redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
    redis.call('ZADD', KEYS[5], tombstoneExpiresAt, record.operationKey)
  end
  redis.call('ZREM', KEYS[2], reservationId)
  return directExpiryReply(record, expiredState)
end
local lastGrowth = record.lastVectorGrowth
if lastGrowth and lastGrowth.incrementHash == incrementHash then
  if lastGrowth.expectedGrowthCursor ~= expectedGrowthCursor or lastGrowth.fingerprint ~= fingerprint then return { 'conflict' } end
  if lastGrowth.accepted == true then
    return { 'accepted_replay', lastGrowth.nextGrowthCursor, cjson.encode(lastGrowth.previousReservedByDimensions), cjson.encode(lastGrowth.reservedByDimensions), cjson.encode(lastGrowth.remainingByHashes) }
  end
  return { 'quota_replay', lastGrowth.nextGrowthCursor, lastGrowth.limitingDimensionHash, lastGrowth.limitingBudgetHash, tostring(lastGrowth.remaining) }
end
if not record.growthCursor then return { 'not_supported' } end
if record.growthCursor ~= expectedGrowthCursor then return { 'stale_cursor' } end
if #record.dimensions ~= #dimensions then return { 'dimension_mismatch' } end
for index, dimension in ipairs(dimensions) do
  local stored = record.dimensions[index]
  if stored.hash ~= dimension.hash or #stored.budgetHashes ~= #dimension.budgets then return { 'dimension_mismatch' } end
  for budgetIndex, budget in ipairs(dimension.budgets) do
    if stored.budgetHashes[budgetIndex] ~= budget.hash then return { 'dimension_mismatch' } end
  end
end
local remainingByHashes = {}
local limitingDimensionHash = nil
local limitingBudgetHash = nil
local limitingRemaining = nil
for _, dimension in ipairs(dimensions) do
  for _, budget in ipairs(dimension.budgets) do
    local used = tonumber(redis.call('HGET', KEYS[1], budget.hash) or '0')
    local remaining = tonumber(budget.limit) - used
    if remaining < 0 then remaining = 0 end
    table.insert(remainingByHashes, { dimensionHash = dimension.hash, budgetHash = budget.hash, remaining = remaining - tonumber(dimension.additionalUnits) })
    if not limitingBudgetHash and tonumber(dimension.additionalUnits) > remaining then
      limitingDimensionHash = dimension.hash
      limitingBudgetHash = budget.hash
      limitingRemaining = remaining
    end
  end
end
if limitingBudgetHash then
  record.growthCursor = nextGrowthCursor
  record.lastVectorGrowth = {
    accepted = false, incrementHash = incrementHash, expectedGrowthCursor = expectedGrowthCursor,
    fingerprint = fingerprint, nextGrowthCursor = nextGrowthCursor,
    limitingDimensionHash = limitingDimensionHash, limitingBudgetHash = limitingBudgetHash,
    remaining = limitingRemaining
  }
  redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
  return { 'quota_exceeded', nextGrowthCursor, limitingDimensionHash, limitingBudgetHash, tostring(limitingRemaining) }
end
local previous = {}
local current = {}
for index, dimension in ipairs(dimensions) do
  local stored = record.dimensions[index]
  table.insert(previous, { hash = stored.hash, reservedUnits = tonumber(stored.reservedUnits) })
  local nextReserved = tonumber(stored.reservedUnits) + tonumber(dimension.additionalUnits)
  for _, budget in ipairs(dimension.budgets) do
    if tonumber(dimension.additionalUnits) > 0 then redis.call('HINCRBY', KEYS[1], budget.hash, tonumber(dimension.additionalUnits)) end
  end
  stored.reservedUnits = nextReserved
  table.insert(current, { hash = stored.hash, reservedUnits = nextReserved })
end
record.growthCursor = nextGrowthCursor
record.lastVectorGrowth = {
  accepted = true, incrementHash = incrementHash, expectedGrowthCursor = expectedGrowthCursor,
  fingerprint = fingerprint, nextGrowthCursor = nextGrowthCursor,
  previousReservedByDimensions = previous, reservedByDimensions = current,
  remainingByHashes = remainingByHashes
}
redis.call('HSET', KEYS[3], reservationId, cjson.encode(record))
return { 'accepted', nextGrowthCursor, cjson.encode(previous), cjson.encode(current), cjson.encode(remainingByHashes) }
`;


export const RECONCILE_OPERATION_SCRIPT = String.raw`
local reservationId = ARGV[1]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local raw = redis.call('HGET', KEYS[1], reservationId)
if not raw then return { 'absent' } end
local record = cjson.decode(raw)
if record.mode == 'vector' then return { 'mode_mismatch' } end
local state = record.state
local reservedUnits = tonumber(record.reservedUnits)
local expiresAt = tonumber(record.expiresAt)
local budgetHashes = cjson.encode(record.budgetHashes or {})
local growthCursor = record.growthCursor or ''
if state == 'pending' or state == 'liable' then
  if expiresAt <= now then
    return { 'expired', state, tostring(reservedUnits), tostring(expiresAt), budgetHashes, growthCursor }
  end
  return { 'active', state, tostring(reservedUnits), tostring(expiresAt), budgetHashes, growthCursor }
end
if state ~= 'settled' then return { 'invalid_state' } end
local tombstoneScore = redis.call('ZSCORE', KEYS[2], record.operationKey)
if not tombstoneScore then return { 'invalid_state' } end
local tombstoneExpiresAt = tonumber(tombstoneScore)
if tombstoneExpiresAt <= now then return { 'absent' } end
if record.outcome == 'lease_expired_after_execution_started' then
  return { 'expired', 'liable', tostring(reservedUnits), tostring(expiresAt), budgetHashes, growthCursor }
end
local actualUnits = tonumber(record.actualUnits)
if not actualUnits then return { 'invalid_state' } end
return { 'settled', tostring(reservedUnits), tostring(actualUnits), tostring(tombstoneExpiresAt), budgetHashes }
`;
