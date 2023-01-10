import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';

export class SaasSubscriptionServerInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const secret = new secretmanager.Secret(this, 'Secret', {
      secretName: 'saas-subscription-server-secret',
      secretObjectValue: {
        DB_DATABASE: cdk.SecretValue.unsafePlainText(process.env.DB_DATABASE!),

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
    });

    rdsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(3306),
      "allow public mysql access"
    );
 
    const instance = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_19,
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
  }
}
