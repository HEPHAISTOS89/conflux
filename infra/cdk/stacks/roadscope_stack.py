"""RoadScopeStack: the whole AWS footprint for RoadScope in one stack."""
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_apigatewayv2 as apigw,
    aws_apigatewayv2_integrations as apigw_int,
    aws_cloudfront as cf,
    aws_cloudfront_origins as origins,
    aws_cloudwatch as cw,
    aws_cloudwatch_actions as cw_actions,
    aws_ec2 as ec2,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_s3 as s3,
    aws_scheduler as scheduler,
    aws_sqs as sqs,
)
from constructs import Construct

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / "build"
INFERENCE_PROFILE = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
FOUNDATION_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0"
PANDAS_LAYER = "arn:aws:lambda:us-east-2:336392948345:layer:AWSSDKPandas-Python313-Arm64:1"


class RoadScopeStack(Stack):
    def __init__(self, scope: Construct, cid: str, **kw) -> None:
        super().__init__(scope, cid, **kw)

        # ---------- S3 data lake ----------
        bucket = s3.Bucket(
            self, "Data",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            event_bridge_enabled=True,   # object events -> EventBridge (site trajectory drops under sites/)
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[s3.LifecycleRule(
                id="noncurrent-30d",
                noncurrent_version_expiration=Duration.days(30),
            )],
        )

        def log_group(name: str) -> logs.LogGroup:
            return logs.LogGroup(
                self, f"{name}Logs", log_group_name=f"/aws/lambda/{name}",
                retention=logs.RetentionDays.TWO_WEEKS, removal_policy=RemovalPolicy.DESTROY,
            )

        # ---------- API Lambda ----------
        api = lambda_.Function(
            self, "Api",
            function_name="roadscope-api",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            memory_size=1024,
            timeout=Duration.seconds(15),
            code=lambda_.Code.from_asset(str(BUILD / "api.zip")),
            handler="app.lambda_handler.handler",
            environment={"DATA_BUCKET": bucket.bucket_name,
                         "BEDROCK_MODEL_ID": INFERENCE_PROFILE, "LOG_LEVEL": "INFO",
                         "API_FUNCTION_NAME": "roadscope-api", "INGEST_FUNCTION_NAME": "roadscope-ingest",
                         "CORS_ORIGINS": "http://localhost:5173"},
            logging_format=lambda_.LoggingFormat.JSON,
            log_group=log_group("roadscope-api"),
        )
        bucket.grant_read(api, "curated/*")
        api.add_to_role_policy(iam.PolicyStatement(
            actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
            resources=[f"arn:aws:bedrock:us-east-2:{self.account}:inference-profile/{INFERENCE_PROFILE}"]
            + [f"arn:aws:bedrock:{r}::foundation-model/{FOUNDATION_MODEL}" for r in ("us-east-1", "us-east-2", "us-west-2")],
        ))
        api.add_to_role_policy(iam.PolicyStatement(actions=["cloudwatch:GetMetricData"], resources=["*"]))
        # ---------- Public edge for the API ----------
        # "httpapi" (default): API Gateway HTTP API with stage throttling — works on unverified accounts.
        # "cloudfront": CloudFront + OAC-protected Function URL with 300 s caching (needs a verified account).
        edge = self.node.try_get_context("edge") or "httpapi"
        dist = None
        if edge == "cloudfront":
            api_url = api.add_function_url(auth_type=lambda_.FunctionUrlAuthType.AWS_IAM)
            origin = origins.FunctionUrlOrigin.with_origin_access_control(api_url)
            cached = cf.CachePolicy(
                self, "ApiCache",
                default_ttl=Duration.seconds(300), min_ttl=Duration.seconds(0), max_ttl=Duration.seconds(300),
                query_string_behavior=cf.CacheQueryStringBehavior.all(),
                enable_accept_encoding_gzip=True, enable_accept_encoding_brotli=True,
            )
            no_cache = dict(
                origin=origin,
                viewer_protocol_policy=cf.ViewerProtocolPolicy.HTTPS_ONLY,
                cache_policy=cf.CachePolicy.CACHING_DISABLED,
                origin_request_policy=cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            )
            dist = cf.Distribution(
                self, "Cdn",
                comment="RoadScope API",
                price_class=cf.PriceClass.PRICE_CLASS_100,
                default_behavior=cf.BehaviorOptions(
                    origin=origin,
                    viewer_protocol_policy=cf.ViewerProtocolPolicy.HTTPS_ONLY,
                    allowed_methods=cf.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                    cache_policy=cached,
                    compress=True,
                ),
                additional_behaviors={
                    "/api/v1/ask": cf.BehaviorOptions(allowed_methods=cf.AllowedMethods.ALLOW_ALL, **no_cache),
                    "/api/v1/platform/status": cf.BehaviorOptions(**no_cache),
                },
            )
            CfnOutput(self, "ApiBaseUrl", value=f"https://{dist.distribution_domain_name}")
        else:
            http = apigw.HttpApi(
                self, "HttpApi", api_name="roadscope-api",
                default_integration=apigw_int.HttpLambdaIntegration("ApiInt", api),
                create_default_stage=False,
            )
            apigw.HttpStage(
                self, "Stage", http_api=http, stage_name="$default", auto_deploy=True,
                throttle=apigw.ThrottleSettings(rate_limit=20, burst_limit=40),
            )
            CfnOutput(self, "ApiBaseUrl", value=http.api_endpoint)

        # ---------- Ingest Lambda ----------
        dlq = sqs.Queue(self, "IngestDlq", retention_period=Duration.days(14),
                        encryption=sqs.QueueEncryption.SQS_MANAGED, enforce_ssl=True)
        ingest = lambda_.Function(
            self, "Ingest",
            function_name="roadscope-ingest",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            memory_size=1024,
            timeout=Duration.minutes(15),
            code=lambda_.Code.from_asset(str(BUILD / "ingest.zip")),
            handler="roadscope_pipeline.lambda_ingest.handler",
            layers=[lambda_.LayerVersion.from_layer_version_arn(self, "PandasLayer", PANDAS_LAYER)],
            environment={"DATA_BUCKET": bucket.bucket_name, "LOG_LEVEL": "INFO"},
            logging_format=lambda_.LoggingFormat.JSON,
            log_group=log_group("roadscope-ingest"),
            dead_letter_queue=dlq,
            retry_attempts=2,
        )
        bucket.grant_read_write(ingest, "raw/*")
        bucket.grant_read_write(ingest, "curated/*")
        # "Run ingest" on the Platform page: the API may start this one function asynchronously and keep
        # its cooldown lock under ops/ (POST /api/v1/ops/ingest). Nothing else is invocable from the API.
        api.add_to_role_policy(iam.PolicyStatement(actions=["lambda:InvokeFunction"], resources=[ingest.function_arn]))
        bucket.grant_read_write(api, "ops/*")
        events.Rule(
            self, "WeeklyIngest",
            schedule=events.Schedule.cron(minute="0", hour="8", week_day="MON"),
            targets=[targets.LambdaFunction(ingest, retry_attempts=2)],
        )
        # ---------- Site trajectory drop ----------
        # A lab feed dropped as s3://<bucket>/sites/<site_id>/{site.json, tracks.csv|json} (docs/SITE_TRAJECTORY_SCHEMA.md):
        # the tracks.* object-created event runs the same ingest function, which converts the feed, computes
        # TTC/PET/DRAC, pedestrian PET and failure-to-yield, and publishes curated/intersections/<site_id>*.json.
        bucket.grant_read(ingest, "sites/*")
        events.Rule(
            self, "SiteDrop",
            description="Site trajectory feed dropped under sites/<site_id>/tracks.csv|json",
            event_pattern=events.EventPattern(
                source=["aws.s3"], detail_type=["Object Created"],
                detail={"bucket": {"name": [bucket.bucket_name]},
                        "object": {"key": [{"wildcard": "sites/*/tracks.csv"}, {"wildcard": "sites/*/tracks.json"}]}},
            ),
            targets=[targets.LambdaFunction(ingest, retry_attempts=2)],
        )

        # ---------- EC2 batch worker ----------
        vpc = ec2.Vpc.from_lookup(self, "DefaultVpc", is_default=True)
        sg = ec2.SecurityGroup(self, "WorkerSg", vpc=vpc, allow_all_outbound=True,
                               description="RoadScope worker: no inbound")
        role = iam.Role(
            self, "WorkerRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[iam.ManagedPolicy.from_aws_managed_policy_name("AmazonSSMManagedInstanceCore")],
        )
        for p in ("raw/*", "curated/*", "jobs/*"):
            bucket.grant_read_write(role, p)
        user_data = ec2.UserData.for_linux()
        user_data.add_commands(
            (ROOT / "scripts" / "ec2_batch_job.sh").read_text().replace("__DATA_BUCKET__", bucket.bucket_name)
        )
        worker = ec2.Instance(
            self, "Worker",
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            associate_public_ip_address=True,  # default VPC, no NAT: needed for S3/SSM egress
            instance_type=ec2.InstanceType("t4g.small"),
            machine_image=ec2.MachineImage.latest_amazon_linux2023(cpu_type=ec2.AmazonLinuxCpuType.ARM_64),
            security_group=sg,
            role=role,
            require_imdsv2=True,
            instance_initiated_shutdown_behavior=ec2.InstanceInitiatedShutdownBehavior.STOP,
            user_data=user_data,
            block_devices=[ec2.BlockDevice(device_name="/dev/xvda", volume=ec2.BlockDeviceVolume.ebs(
                12, volume_type=ec2.EbsDeviceVolumeType.GP3, encrypted=True, delete_on_termination=True))],
        )
        # Backstop for a worker that never reaches its own shutdown: stop it after an idle hour.
        cw.Alarm(
            self, "WorkerIdle",
            metric=cw.Metric(namespace="AWS/EC2", metric_name="CPUUtilization",
                             dimensions_map={"InstanceId": worker.instance_id}, statistic="Maximum",
                             period=Duration.minutes(15)),
            threshold=5, comparison_operator=cw.ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluation_periods=4, treat_missing_data=cw.TreatMissingData.NOT_BREACHING,
        ).add_alarm_action(cw_actions.Ec2Action(cw_actions.Ec2InstanceAction.STOP))
        sched_role = iam.Role(self, "SchedulerRole",
                              assumed_by=iam.ServicePrincipal("scheduler.amazonaws.com",
                                  conditions={"StringEquals": {"aws:SourceAccount": self.account}}))
        sched_role.add_to_policy(iam.PolicyStatement(
            actions=["ec2:StartInstances"],
            resources=[f"arn:aws:ec2:{self.region}:{self.account}:instance/{worker.instance_id}"],
        ))
        scheduler.CfnSchedule(
            self, "MonthlyWorker",
            name="roadscope-worker-monthly",
            schedule_expression="cron(0 9 1 * ? *)",
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(mode="OFF"),
            target=scheduler.CfnSchedule.TargetProperty(
                arn="arn:aws:scheduler:::aws-sdk:ec2:startInstances",
                role_arn=sched_role.role_arn,
                input=self.to_json_string({"InstanceIds": [worker.instance_id]}),
            ),
        )

        # ---------- CloudWatch ----------
        five = Duration.minutes(5)
        api_err = api.metric_errors(period=five, statistic="Sum")
        cw.Alarm(self, "ApiErrors", alarm_name="roadscope-api-errors", metric=api_err, threshold=5,
                 evaluation_periods=1, comparison_operator=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                 treat_missing_data=cw.TreatMissingData.NOT_BREACHING)
        cw.Alarm(self, "IngestErrors", alarm_name="roadscope-ingest-errors",
                 metric=ingest.metric_errors(period=five, statistic="Sum"), threshold=1, evaluation_periods=1,
                 comparison_operator=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                 treat_missing_data=cw.TreatMissingData.NOT_BREACHING)
        site_failed = logs.MetricFilter(
            self, "SiteIngestFailed", log_group=ingest.log_group,
            metric_namespace="Conflux/Sites", metric_name="SiteIngestFailed", metric_value="1", default_value=0,
            filter_pattern=logs.FilterPattern.string_value("$.event", "=", "site_ingest_failed"),
        ).metric(period=five, statistic="Sum")
        cw.Alarm(self, "SiteIngestFailedAlarm", alarm_name="roadscope-site-ingest-failed", metric=site_failed, threshold=1,
                 evaluation_periods=1, comparison_operator=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                 treat_missing_data=cw.TreatMissingData.NOT_BREACHING,
                 alarm_description="A site trajectory drop under sites/<site_id>/ failed validation or conversion")
        cw.Alarm(self, "DlqDepth", alarm_name="roadscope-ingest-dlq",
                 metric=dlq.metric_approximate_number_of_messages_visible(period=five, statistic="Maximum"),
                 threshold=1, evaluation_periods=1,
                 comparison_operator=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                 treat_missing_data=cw.TreatMissingData.NOT_BREACHING)
        dash = cw.Dashboard(self, "Dashboard", dashboard_name="RoadScope")
        dash.add_widgets(
            cw.GraphWidget(title="API invocations / errors", left=[api.metric_invocations(period=five)], right=[api_err]),
            cw.GraphWidget(title="API duration p95 (ms)", left=[api.metric_duration(period=five, statistic="p95")]),
            cw.GraphWidget(title="Ingest errors / duration", left=[ingest.metric_errors(period=five)],
                           right=[ingest.metric_duration(period=five, statistic="Maximum")]),
        )
        dash.add_widgets(
            cw.GraphWidget(title="Worker CPU %", left=[cw.Metric(namespace="AWS/EC2", metric_name="CPUUtilization",
                           dimensions_map={"InstanceId": worker.instance_id}, statistic="Average", period=five)]),
            cw.GraphWidget(title="Ingest DLQ depth", left=[dlq.metric_approximate_number_of_messages_visible(period=five)]),
            cw.GraphWidget(title="Site drops failed", left=[site_failed]),
        )

        if dist is not None:
            cf_requests = cw.Metric(namespace="AWS/CloudFront", metric_name="Requests", region="us-east-1",
                                    dimensions_map={"DistributionId": dist.distribution_id, "Region": "Global"},
                                    statistic="Sum", period=five)
            cf_5xx = cw.Metric(namespace="AWS/CloudFront", metric_name="5xxErrorRate", region="us-east-1",
                               dimensions_map={"DistributionId": dist.distribution_id, "Region": "Global"},
                               statistic="Average", period=five)
            dash.add_widgets(cw.GraphWidget(title="CloudFront requests / 5xx %", left=[cf_requests], right=[cf_5xx]))
        else:
            dash.add_widgets(cw.GraphWidget(title="HTTP API requests / 5xx", left=[cw.Metric(namespace="AWS/ApiGateway", metric_name="Count",
                dimensions_map={"ApiId": http.api_id}, statistic="Sum", period=five)], right=[cw.Metric(namespace="AWS/ApiGateway", metric_name="5xx",
                dimensions_map={"ApiId": http.api_id}, statistic="Sum", period=five)]))

        # ---------- Outputs ----------
        CfnOutput(self, "BucketName", value=bucket.bucket_name)
        CfnOutput(self, "ApiFunctionName", value=api.function_name)
        CfnOutput(self, "IngestFunctionName", value=ingest.function_name)
        CfnOutput(self, "WorkerInstanceId", value=worker.instance_id)
        CfnOutput(self, "DashboardUrl",
                  value=f"https://{self.region}.console.aws.amazon.com/cloudwatch/home?region={self.region}#dashboards:name=RoadScope")
