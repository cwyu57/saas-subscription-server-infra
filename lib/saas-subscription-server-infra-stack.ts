import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';

export class SaasSubscriptionServerInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const secret = this.prepareSecrets();

    const vpc = this.prepareVpc();

    const database = this.prepareDatabase(vpc);

    const ecrRepository = this.prepareContainerRegistry();

    const { lb, fargateService } = this.prepareComputeLayer(vpc, ecrRepository, database, secret);
    
    const { certificate, hostedZone } = this.setupDns();

    const distribution = this.prepareCdn(lb, certificate);

    this.addAlternateDomainNameToCdn(distribution, hostedZone);

    const artifactBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: 'saas-subscription-cicd-artifacts',
    });

    const codebuildProject = new codebuild.Project(this, 'CodeBuildProject', {
      projectName: 'saas-subscription-server',
      source: codebuild.Source.gitHub({
        owner: 'cwyu57',
        repo: 'saas-subscription-server',
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andTagIs('*'),
        ],
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true,
      },
      environmentVariables: {
        AWS_ACCOUNT_ID: {
          value: cdk.Stack.of(this).account,
        },
        ECR_URI: {
          value: `${cdk.Stack.of(this).account}.dkr.ecr.${cdk.Stack.of(this).region}.amazonaws.com/saas-subscription-server`,
        },
      },
      vpc: vpc,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 16,
            },
          },
          build: {
            commands: [
              // 'printenv',
              // 'aws --version',
              // 'docker -v',
              // "AWS_ACCOUNT_ID=$(aws sts get-caller-identity --output text | awk '{ print $1 }')",
              // "echo $AWS_ACCOUNT_ID",
              // "echo $TAG",

              "TAG=$(echo $CODEBUILD_WEBHOOK_TRIGGER | cut -d / -f 2)",

              "$(aws ecr get-login --no-include-email --region $AWS_REGION)",

              "docker build -t saas-subscription-server .",

              "docker tag saas-subscription-server $ECR_URI:$TAG",
              "docker tag saas-subscription-server $ECR_URI:latest",

              "docker push $ECR_URI:$TAG",
              "docker push $ECR_URI:latest",

              "echo '[{\"name\":\"saas-subscription-server\",\"imageUri\":\"$ECR_URI:$TAG\"}]' > imagedefinitions.json"
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
      artifacts: codebuild.Artifacts.s3({
        bucket: artifactBucket,
        name: 'deployment.zip',
        includeBuildId: false,
      })
    });

    codebuildProject.role?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecr:*'],
      resources: [ecrRepository.repositoryArn]
    }));
    codebuildProject.role?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*']
    }));

    const codepipelineArtifacts = new codepipeline.Artifact();

    const codepipelineProject = new codepipeline.Pipeline(this, 'CodePipelineProject', {
      pipelineName: 'saas-subscription-server',
      // role: config.iamRole,
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipelineactions.S3SourceAction({
              actionName: 'FetchECRImageDefinition',
              bucket: artifactBucket,
              bucketKey: 'deployment.zip',
              output: codepipelineArtifacts,
            }),
          ],
        },
        {
          stageName: `DeployToECS`,
          actions: [
            new codepipelineactions.EcsDeployAction({
              actionName: `DeployToECS`,
              service: fargateService,
              input: codepipelineArtifacts,
              runOrder: 1,
            }),
          ],
        },
      ]
    });


  }

  private addAlternateDomainNameToCdn(distribution: cdk.aws_cloudfront.Distribution, hostedZone: cdk.aws_route53.PublicHostedZone) {
    new route53.CnameRecord(this, 'CName', {
      domainName: distribution.domainName,
      recordName: 'saas-subscription-api.cwyu57.app',
      zone: hostedZone,
    });
  }

  private prepareCdn(lb: cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer, certificate: cdk.aws_certificatemanager.DnsValidatedCertificate) {
    return new cloudfront.Distribution(this, 'Distribution', {
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
  }

  private setupDns() {
    const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: 'cwyu57.app',
    });

    const certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
      domainName: '*.cwyu57.app',
      hostedZone: hostedZone,
      region: 'us-east-1', // ACM certificates that are used with CloudFront -- or higher-level constructs which rely on CloudFront -- must be in the us-east-1 region.
    });
    return { certificate, hostedZone };
  }

  private prepareComputeLayer(vpc: cdk.aws_ec2.Vpc, ecrRepository: cdk.aws_ecr.Repository, database: cdk.aws_rds.DatabaseInstance, secret: cdk.aws_secretsmanager.Secret) {
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
        DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DB_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
        DB_DATABASE: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
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

    const listener = lb.addListener("Listener", {
      port: 80,
    });

    listener.addTargets("ECS", {
      port: 80,
      targets: [fatgetService],
    });
    return { lb, fatgetService };
  }

  private prepareContainerRegistry() {
    return new ecr.Repository(this, 'ECR', {
      repositoryName: 'saas-subscription-server'
    });
  }

  private prepareDatabase(vpc: cdk.aws_ec2.Vpc) {
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
    return instance;
  }

  private prepareVpc() {
    return new ec2.Vpc(this, 'VPC', {
      vpcName: 'saas-subscription-vpc',
    });
  }

  private prepareSecrets() {
    return new secretmanager.Secret(this, 'Secret', {
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
  }
}
