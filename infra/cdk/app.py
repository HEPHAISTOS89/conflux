#!/usr/bin/env python3
import aws_cdk as cdk

from stacks.roadscope_stack import RoadScopeStack

app = cdk.App()
RoadScopeStack(
    app,
    "RoadScopeStack",
    env=cdk.Environment(account="287785301961", region="us-east-2"),
    description="RoadScope: S3 lake, Lambda API + ingest, EC2 batch worker, CloudFront, CloudWatch",
)
cdk.Tags.of(app).add("Project", "RoadScope")
cdk.Tags.of(app).add("Owner", "HEPHAISTOS89")
app.synth()
