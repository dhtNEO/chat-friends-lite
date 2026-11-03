output "public_ip" {
  description = "Endereço IP público estático alocado para a VM"
  value       = google_compute_address.static_ip.address
}

output "vm_name" {
  description = "Nome da instância Compute Engine provisionada"
  value       = google_compute_instance.vm.name
}

output "artifact_registry_repository" {
  description = "URL base do repositório Docker no Artifact Registry"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name}"
}

output "service_account_email" {
  description = "E-mail da Service Account associada à VM"
  value       = google_service_account.vm_sa.email
}

output "secrets_created" {
  description = "Lista dos identificadores dos segredos provisionados no Secret Manager"
  value       = [for s in google_secret_manager_secret.secrets : s.secret_id]
}
