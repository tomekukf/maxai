import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Główny stack maxai.
 * Faza 0: minimalny szkielet — bucket S3 na pliki (PDF wizualizacji + zdjęcia produktów).
 * Kolejne zasoby (RDS pgvector, Lambdy, API Gateway) dokładamy w Fazie 1.
 */
export class MaxaiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Bucket na pliki: PDF-y wizualizacji oraz zdjęcia referencyjne produktów.
    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // MVP: pozwalamy usunąć bucket i jego zawartość razem ze stackiem (tanie sprzątanie).
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // CORS dla presigned upload z frontendu.
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

    new CfnOutput(this, 'FilesBucketName', {
      value: filesBucket.bucketName,
      description: 'Nazwa bucketu S3 na pliki (PDF + zdjęcia produktów)',
    });
  }
}
