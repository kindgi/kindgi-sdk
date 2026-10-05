# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Kindgi on Google Cloud Run: the server, the pack service, Cloud SQL, and
# what they stand on. See README.md.

terraform {
  required_version = ">= 1.6"

  # Remote state, configured at init (a partial backend):
  #   terraform init -backend-config=bucket=<state bucket> -backend-config=prefix=<this deployment>
  # A deployment of its own: never share a prefix (or a root module) with
  # the app's own infrastructure. Its state holds that app's resources.
  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 9.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
