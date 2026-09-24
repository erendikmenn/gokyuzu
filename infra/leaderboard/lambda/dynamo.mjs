// DynamoDB store for the leaderboard (AWS SDK v3, part of the Lambda Node.js runtime; not needed for the unit tests).
//
// Table (on-demand, TTL attribute `exp`):  pk (board or rate-limit key) · sk (player hash, '-' for counters)
//   board entry:   pk = b#<mission>[#<day>]  sk = p#<salted player hash>  rk, sc, st, ac, t, v, n?, sec?, exp?
//   rate counter:  pk = rl#<salted hash of address + minute>  sk = '-'  c, exp  (not in the index: no rk)
// Local secondary index `rank` (pk, rk), projecting everything: a board sorted by score.
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });

function marshal(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'number' ? N(v) : S(v);
  }
  return out;
}
function unmarshal(av) {
  const out = {};
  for (const [k, v] of Object.entries(av || {})) out[k] = 'N' in v ? Number(v.N) : v.S;
  return out;
}

export async function createDynamoDb(table, region = process.env.AWS_REGION) {
  const { DynamoDBClient, UpdateItemCommand, PutItemCommand, QueryCommand, GetItemCommand } = await import('@aws-sdk/client-dynamodb');
  const client = new DynamoDBClient({ region, maxAttempts: 2 });

  const db = {
    async hit(pk, exp) {
      const r = await client.send(new UpdateItemCommand({
        TableName: table, Key: { pk: S(pk), sk: S('-') },
        UpdateExpression: 'ADD c :one SET #e = if_not_exists(#e, :exp)',
        ExpressionAttributeNames: { '#e': 'exp' }, ExpressionAttributeValues: { ':one': N(1), ':exp': N(exp) },
        ReturnValues: 'UPDATED_NEW',
      }));
      return Number(r.Attributes.c.N);
    },
    async putBest(item) {
      try {
        await client.send(new PutItemCommand({
          TableName: table, Item: marshal(item),
          ConditionExpression: 'attribute_not_exists(pk) OR rk < :rk', ExpressionAttributeValues: { ':rk': S(item.rk) },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return { written: true, old: null };
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return { written: false, old: e.Item ? unmarshal(e.Item) : null };
        throw e;
      }
    },
    async top(pk, n) {
      const r = await client.send(new QueryCommand({
        TableName: table, IndexName: 'rank', KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': S(pk) },
        ScanIndexForward: false, Limit: n,
        ProjectionExpression: '#n, sc, st, ac, sec, rk', ExpressionAttributeNames: { '#n': 'n' },
      }));
      return (r.Items || []).map(unmarshal);
    },
    async countAbove(pk, rk, cap) {
      const r = await client.send(new QueryCommand({
        TableName: table, IndexName: 'rank', KeyConditionExpression: 'pk = :pk AND rk > :rk',
        ExpressionAttributeValues: { ':pk': S(pk), ':rk': S(rk) }, Select: 'COUNT', Limit: cap,
      }));
      return r.Count || 0;
    },
    /** Opens the TLS connection during the (CPU-boosted) init phase so the first request does not pay for it. */
    async warm() {
      await client.send(new GetItemCommand({ TableName: table, Key: { pk: S('warm'), sk: S('-') }, ProjectionExpression: 'pk' }));
    },
  };
  return db;
}
