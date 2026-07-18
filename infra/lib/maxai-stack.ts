import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'path';

// Model Bedrock (EU inference profile) do ekstrakcji/NLP.
const HAIKU_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
// Model embeddingów (Titan Multimodal, 1024 wym.).
const EMBED_MODEL_ID = 'amazon.titan-embed-image-v1';
// Model vision (opis produktu + rerank) — Sonnet 4.5 (EU inference profile).
const SONNET_MODEL_ID = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

/**
 * Główny stack maxai.
 * Faza 1: bucket S3 (pliki) + VPC (bez NAT) + RDS PostgreSQL 16 (pgvector).
 * Sieć MVP: RDS publicznie dostępny, Lambdy poza VPC → brak NAT/VPC endpoints ($0 extra).
 * Ochrona bazy: silne wygenerowane hasło (Secrets Manager) + SSL.
 */
export class MaxaiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- S3: PDF-y wizualizacji + zdjęcia referencyjne produktów ---
    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY, // MVP: łatwe sprzątanie
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          // TODO (Faza 4): zawęzić do domeny frontendu (Amplify) zamiast '*'.
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // --- VPC: minimalny, BEZ NAT Gateway (oszczędność ~$32/mies) ---
    // Tylko podsieci publiczne — RDS publicznie dostępny (MVP), Lambdy poza VPC.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // --- Security group RDS ---
    // MVP: dostęp z internetu na 5432 (Lambdy poza VPC mają dynamiczne IP).
    // Ochrona: silne hasło + SSL. TODO(produkcja): ograniczyć źródła / RDS prywatny.
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'maxai RDS PostgreSQL - dostep na 5432 (MVP publiczny)',
      allowAllOutbound: true,
    });
    dbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'PostgreSQL (MVP, publiczny)');

    // --- RDS PostgreSQL 16 (pgvector włączymy migracją: CREATE EXTENSION vector) ---
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('16.14', '16'),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true,
      securityGroups: [dbSg],
      databaseName: 'maxai',
      credentials: rds.Credentials.fromGeneratedSecret('maxai_admin'),
      allocatedStorage: 20,
      maxAllocatedStorage: 30,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      storageEncrypted: true,
      backupRetention: Duration.days(0), // MVP: bez automatycznych backupów
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY, // MVP: łatwe sprzątanie
    });

    // --- Lambda: presigned upload URL (Python 3.13, poza VPC) ---
    const presignFn = new lambda.Function(this, 'PresignFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/lambdas/presign')),
      environment: { FILES_BUCKET: filesBucket.bucketName },
      timeout: Duration.seconds(10),
      memorySize: 128,
    });
    filesBucket.grantPut(presignFn);

    // --- HTTP API (API Gateway v2) ---
    const httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: ['*'], // TODO (Faza 4): zawęzić do domeny frontendu
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({
      path: '/uploads/presign',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('PresignInteg', presignFn),
    });

    // --- Lambda: ekstrakcja parametrów (Haiku 4.5 na Bedrock) ---
    const extractFn = new lambda.Function(this, 'ExtractFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/lambdas/extract')),
      environment: { EXTRACT_MODEL_ID: HAIKU_MODEL_ID },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });
    // MVP: uproszczone uprawnienie do wywołania modeli/profili Bedrock.
    // TODO (produkcja): zawęzić resources do ARN profilu EU + modeli bazowych.
    extractFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );
    httpApi.addRoutes({
      path: '/extract',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('ExtractInteg', extractFn),
    });

    // --- Lambda: auto-detekcja mebli na obrazie (Haiku 4.5 vision) ---
    const detectFn = new lambda.Function(this, 'DetectFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/lambdas/detect')),
      environment: { DETECT_MODEL_ID: HAIKU_MODEL_ID },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });
    detectFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] }),
    );
    httpApi.addRoutes({
      path: '/detect',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('DetectInteg', detectFn),
    });

    // --- Lambda: zapis produktu (embedding Titan + INSERT do RDS) ---
    const productsFn = new lambda.Function(this, 'ProductsFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/lambdas/products')),
      environment: {
        FILES_BUCKET: filesBucket.bucketName,
        DB_SECRET_ARN: db.secret!.secretArn,
        EMBED_MODEL_ID: EMBED_MODEL_ID,
        DESCRIBE_MODEL_ID: SONNET_MODEL_ID,
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
    });
    filesBucket.grantReadWrite(productsFn); // read (embedding) + delete (usuwanie zdjęć)
    db.secret!.grantRead(productsFn);
    productsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );
    const productsInteg = new HttpLambdaIntegration('ProductsInteg', productsFn);
    httpApi.addRoutes({
      path: '/products',
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
      integration: productsInteg,
    });
    // Uwaga: zachowujemy nazwę zmiennej {optimaId} (rename na {id} powoduje konflikt route'ów
    // przy deployu). Ścieżka przyjmuje UUID produktu; handler czyta id/optimaId zamiennie.
    httpApi.addRoutes({
      path: '/products/{optimaId}',
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: productsInteg,
    });

    // --- Lambda: wyszukiwanie substytutów (embedding wycinka → pgvector) ---
    const searchFn = new lambda.Function(this, 'SearchFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/lambdas/search')),
      environment: {
        FILES_BUCKET: filesBucket.bucketName,
        DB_SECRET_ARN: db.secret!.secretArn,
        EMBED_MODEL_ID: EMBED_MODEL_ID,
        RERANK_MODEL_ID: SONNET_MODEL_ID,
      },
      timeout: Duration.seconds(60),
      memorySize: 512,
    });
    filesBucket.grantRead(searchFn); // presigned GET wyników
    db.secret!.grantRead(searchFn);
    searchFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] }),
    );
    httpApi.addRoutes({
      path: '/search',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('SearchInteg', searchFn),
    });

    // --- Outputs ---
    new CfnOutput(this, 'FilesBucketName', {
      value: filesBucket.bucketName,
      description: 'Bucket S3 na pliki (PDF + zdjecia produktow)',
    });
    new CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Bazowy URL HTTP API (dodaj /uploads/presign)',
    });
    new CfnOutput(this, 'DbEndpoint', {
      value: db.dbInstanceEndpointAddress,
      description: 'Host RDS PostgreSQL',
    });
    new CfnOutput(this, 'DbPort', {
      value: db.dbInstanceEndpointPort,
      description: 'Port RDS',
    });
    new CfnOutput(this, 'DbSecretName', {
      value: db.secret?.secretName ?? 'n/a',
      description: 'Nazwa sekretu w Secrets Manager (login + haslo)',
    });
  }
}
