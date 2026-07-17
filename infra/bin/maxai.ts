#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MaxaiStack } from '../lib/maxai-stack';

const app = new cdk.App();

new MaxaiStack(app, 'MaxaiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-central-1',
  },
  description: 'maxai MVP — infrastruktura (szkielet Fazy 0)',
});
