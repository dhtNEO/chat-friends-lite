terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.11"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# 1. Habilitação das APIs necessárias no GCP
locals {
  services = [
    "compute.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
  ]
}

resource "google_project_service" "enabled_apis" {
  for_each                   = toset(local.services)
  project                    = var.project_id
  service                    = each.key
  disable_dependent_services = false
  disable_on_destroy         = false
}

# 2. Repositório Docker no Google Artifact Registry com política de retenção
resource "google_artifact_registry_repository" "docker_repo" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  description   = "Repositório de contêineres do Chat Friends v2"
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-minimum-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }

  labels = var.labels

  depends_on = [google_project_service.enabled_apis]
}

# 3. Segredos no GCP Secret Manager
locals {
  secret_ids = [
    "chat-friends-duckdns-token",
    "chat-friends-invite-code",
    "chat-friends-livekit-secret",
  ]
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(local.secret_ids)
  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  labels = var.labels

  depends_on = [google_project_service.enabled_apis]
}

# 4. Service Account dedicada para a VM com permissões mínimas
resource "google_service_account" "vm_sa" {
  project      = var.project_id
  account_id   = "${var.name}-vm-sa"
  display_name = "Service Account da VM Chat Friends"
}

resource "google_artifact_registry_repository_iam_member" "ar_reader" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.docker_repo.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.vm_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "secret_accessor" {
  for_each  = google_secret_manager_secret.secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm_sa.email}"
}

# 5. Rede VPC, Sub-rede e IP Estático
resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  project       = var.project_id
  name          = "${var.name}-subnet"
  ip_cidr_range = "10.42.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

resource "google_compute_address" "static_ip" {
  project = var.project_id
  name    = "${var.name}-static-ip"
  region  = var.region
}

# 6. Regras de Firewall
resource "google_compute_firewall" "allow_web_rtc" {
  project     = var.project_id
  name        = "${var.name}-allow-web-rtc"
  network     = google_compute_network.vpc.id
  target_tags = [var.name]

  source_ranges = ["0.0.0.0/0"]

  # HTTP, HTTPS e LiveKit RTC TCP
  allow {
    protocol = "tcp"
    ports    = ["80", "443", "7881"]
  }

  # HTTP/3 QUIC e Faixa UDP do LiveKit RTC
  allow {
    protocol = "udp"
    ports    = ["443", "50000-50100"]
  }
}

resource "google_compute_firewall" "allow_ssh" {
  project     = var.project_id
  name        = "${var.name}-allow-ssh"
  network     = google_compute_network.vpc.id
  target_tags = [var.name]

  source_ranges = [var.ssh_diagnostic_cidr]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# 7. Instância Compute Engine (e2-small, Debian 13 LTS)
resource "google_compute_instance" "vm" {
  project                   = var.project_id
  name                      = var.name
  machine_type              = var.machine_type
  zone                      = var.zone
  tags                      = [var.name]
  labels                    = var.labels
  deletion_protection       = false
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-13"
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {
      nat_ip = google_compute_address.static_ip.address
    }
  }

  service_account {
    email  = google_service_account.vm_sa.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    domain                 = var.domain
    registry_prefix        = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name}"
  }

  metadata_startup_script = file("${path.module}/startup.sh")

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  depends_on = [
    google_artifact_registry_repository_iam_member.ar_reader,
    google_secret_manager_secret_iam_member.secret_accessor,
  ]
}
