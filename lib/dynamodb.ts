import type { TableItem, TableStore } from './types';

export async function create(): Promise<TableStore> {
  let DynamoDBClient: typeof import('@aws-sdk/client-dynamodb').DynamoDBClient;
  let CreateTableCommand: typeof import('@aws-sdk/client-dynamodb').CreateTableCommand;
  let DescribeTableCommand: typeof import('@aws-sdk/client-dynamodb').DescribeTableCommand;
  let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  let PutCommand: typeof import('@aws-sdk/lib-dynamodb').PutCommand;
  let GetCommand: typeof import('@aws-sdk/lib-dynamodb').GetCommand;
  let QueryCommand: typeof import('@aws-sdk/lib-dynamodb').QueryCommand;
  let DeleteCommand: typeof import('@aws-sdk/lib-dynamodb').DeleteCommand;
  let ScanCommand: typeof import('@aws-sdk/lib-dynamodb').ScanCommand;
  let BatchWriteCommand: typeof import('@aws-sdk/lib-dynamodb').BatchWriteCommand;
  try {
    ({ DynamoDBClient, CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb'));
    ({ DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand, ScanCommand, BatchWriteCommand } = await import('@aws-sdk/lib-dynamodb'));
  } catch {
    throw new Error('Install @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb before using CAREBELL_STORE=dynamodb.');
  }
  const tableName = process.env.CAREBELL_TABLE || 'carebell';
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.DYNAMODB_ENDPOINT || undefined
  });
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' }
      ]
    }));
  }

  type WriteRequest = { DeleteRequest: { Key: { pk: string; sk: string } } } | { PutRequest: { Item: TableItem } };

  async function batch(requests: WriteRequest[]): Promise<void> {
    for (let index = 0; index < requests.length; index += 25) {
      let pending = requests.slice(index, index + 25);
      while (pending.length) {
        const result = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        pending = (result.UnprocessedItems && result.UnprocessedItems[tableName] as WriteRequest[]) || [];
      }
    }
  }

  const store: TableStore = {
    async get(pk, sk) {
      const result = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
      return (result.Item as TableItem | undefined) || null;
    },
    async put(item) {
      await doc.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async delete(pk, sk) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }));
    },
    async query(pk) {
      const items: TableItem[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const result = await doc.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ExclusiveStartKey: startKey
        }));
        items.push(...((result.Items as TableItem[]) || []));
        startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
      return items.sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    },
    async listUserIds() {
      const ids: string[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const result = await doc.send(new ScanCommand({
          TableName: tableName,
          FilterExpression: 'sk = :sk',
          ExpressionAttributeValues: { ':sk': 'PROFILE' },
          ProjectionExpression: 'pk',
          ExclusiveStartKey: startKey
        }));
        for (const item of result.Items || []) {
          if (String(item.pk).startsWith('USER#')) ids.push(String(item.pk).slice('USER#'.length));
        }
        startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
      return ids;
    },
    async replaceUser(pk, items) {
      const existing = await store.query(pk);
      const deletes = existing
        .filter((item) => item.sk !== 'PROFILE')
        .map((item) => ({ DeleteRequest: { Key: { pk, sk: item.sk } } }));
      await batch(deletes);
      await batch(items.map((item) => ({ PutRequest: { Item: item } })));
    }
  };
  return store;
}
