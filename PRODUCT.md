# PRODUCT — RoadScope

> Inferred from the owner's brief and lab research (owner asked not to be interviewed). Assumptions are marked (A).

## What it is
A proactive road-safety analysis portal for Lubbock County, Texas: HSM network screening on TxDOT data, corridor straight-line diagrams, vulnerable-road-user crash analysis, and an intersection lab that computes surrogate safety measures (TTC, PET, DRAC) and repairs occluded trajectories on real NGSIM data. Serverless AWS pipeline, Bedrock analyst.

## Who it is for
Primary: Prof. Hongchao Liu and Dr. Qiyang Luo, TransTech Lab, Texas Tech — transportation engineers working on roadside LiDAR perception, conflict-based proactive safety, trajectory repair, VISSIM calibration, pedestrian failure-to-yield (USDOT 2026, SPAG region), TxDOT Lubbock District support. Secondary (A): TxDOT/Lubbock MPO/SPAG engineers who would use the promised data dashboard.

## The job
In minutes, a reviewer should (1) recognise their own discipline — methods, units, vocabulary, Lubbock corridors; (2) see real data processed rigorously with provenance and limitations; (3) see a complete, wired, deployed AWS system; (4) conclude the author can already do the GA job.

## Voice
Precise, sober, engineering-report register. US customary units with SI where the method is SI. Name methods (HSM Part B, Negative Binomial SPF, Empirical Bayes, KABCO, PBCAT). Never overclaim: synthetic or stand-in data is labelled (NGSIM is California, used as a LiDAR-trajectory stand-in).

## Constraints
Public repo, Vercel frontend, AWS us-east-2 within $100 credits. TxDOT data © TxDOT (informational, disclaimer); NGSIM CC BY-SA 3.0; FARS public domain. Must work desktop/tablet/mobile, WCAG AA, reduced motion.

## Platform
web
