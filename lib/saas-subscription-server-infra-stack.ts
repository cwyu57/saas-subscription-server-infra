import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';

export class SaasSubscriptionServerInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const secret = new secretmanager.Secret(this, 'Secret', {
      secretName: 'saas-subscription-server-secret',
      secretObjectValue: {
        PRIVATE_KEY_PATH_BASE64_STR: cdk.SecretValue.unsafePlainText(process.env.PRIVATE_KEY_PATH_BASE64_STR!),
        PUBLIC_KEY_PATH_BASE64_STR: cdk.SecretValue.unsafePlainText(process.env.PUBLIC_KEY_PATH_BASE64_STR!),

        SWAGGER_USERNAME: cdk.SecretValue.unsafePlainText(process.env.SWAGGER_USERNAME!),
        SWAGGER_PASSWORD: cdk.SecretValue.unsafePlainText(process.env.SWAGGER_PASSWORD!),

        SYSTEM_API_KEY: cdk.SecretValue.unsafePlainText(process.env.SYSTEM_API_KEY!),

        TAP_PAY_MERCHANT_ID: cdk.SecretValue.unsafePlainText(process.env.TAP_PAY_MERCHANT_ID!),
        TAP_PAY_PARTNER_KEY: cdk.SecretValue.unsafePlainText(process.env.TAP_PAY_PARTNER_KEY!),
      },
    });

    const vpc = new ec2.Vpc(this, 'VPC', {
      vpcName: 'saas-subscription-vpc',
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this, "RdsSecurityGroup", {
      vpc,
      securityGroupName: 'saas-subscription-sg'
    });

    rdsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(3306),
      "allow public mysql access"
    );

    const instance = new rds.DatabaseInstance(this, "Database", {
      databaseName: 'SaasSubscription',
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_31,
      }),
      vpc,
      deleteAutomatedBackups: true,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      allocatedStorage: 10,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroups: [rdsSecurityGroup],
    });

    const ecrRepository = new ecr.Repository(this, 'ECR', {
      repositoryName: 'saas-subscription-server'
    });

    const cluster = new ecs.Cluster(this, "EcsCluster", { vpc, clusterName: 'saas-subscription-cluster' });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef");

    const container = taskDefinition.addContainer("WebContainer", {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, '1.0.0'),
      memoryLimitMiB: 512,
      environment: {
        NODE_ENV: 'staging',
        DOTENV_FLOW_SILENT: 'false',
        DB_MAX_CONNECTION: '10',
        DB_MAX_RETRY: '3',
        TAP_PAY_BASE_URL: 'https://sandbox.tappaysdk.com',
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(instance.secret!, 'host'),
        DB_USERNAME: ecs.Secret.fromSecretsManager(instance.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(instance.secret!, 'password'),
        DB_PORT: ecs.Secret.fromSecretsManager(instance.secret!, 'port'),
        DB_DATABASE: ecs.Secret.fromSecretsManager(instance.secret!, 'dbname'),
        PRIVATE_KEY_PATH_BASE64_STR: ecs.Secret.fromSecretsManager(secret, 'PRIVATE_KEY_PATH_BASE64_STR'),
        PUBLIC_KEY_PATH_BASE64_STR: ecs.Secret.fromSecretsManager(secret, 'PUBLIC_KEY_PATH_BASE64_STR'),
        SWAGGER_USERNAME: ecs.Secret.fromSecretsManager(secret, 'SWAGGER_USERNAME'),
        SWAGGER_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'SWAGGER_PASSWORD'),
        SYSTEM_API_KEY: ecs.Secret.fromSecretsManager(secret, 'SYSTEM_API_KEY'),
        TAP_PAY_MERCHANT_ID: ecs.Secret.fromSecretsManager(secret, 'TAP_PAY_MERCHANT_ID'),
        TAP_PAY_PARTNER_KEY: ecs.Secret.fromSecretsManager(secret, 'TAP_PAY_PARTNER_KEY'),
      },
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'saas-subscription-server' }),
    });
    container.addPortMappings({
      containerPort: 8080,
    });

    const fatgetService = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition,
      serviceName: 'saas-subscription-svc'
    });

    const lb = new elbv2.ApplicationLoadBalancer(this, "LB", {
      vpc,
      internetFacing: true,
      loadBalancerName: 'saas-subscription-lb',
    });

    const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: 'cwyu57.app',
    });

    const certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
      domainName: '*.cwyu57.app',
      hostedZone: hostedZone,
      region: 'us-east-1', // ACM certificates that are used with CloudFront -- or higher-level constructs which rely on CloudFront -- must be in the us-east-1 region.
    });

    const certificateTokyo = new acm.DnsValidatedCertificate(this, 'CertificateTokyo', {
      domainName: '*.cwyu57.app',
      hostedZone: hostedZone,
    });

    const listener = lb.addListener("Listener", {
      // certificates: [certificateTokyo],
      port: 80,
    });

    listener.addTargets("ECS", {
      port: 80,
      targets: [fatgetService],
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(lb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      certificate: certificate,
      domainNames: [
        'saas-subscription-api.cwyu57.app',
      ],
    });


    new route53.CnameRecord(this, 'CName', {
      domainName: distribution.domainName,
      recordName: 'saas-subscription-api.cwyu57.app',
      zone: hostedZone,
    })

  }
}
