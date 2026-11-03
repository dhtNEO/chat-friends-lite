variable "project_id" {
  description = "ID do projeto existente no Google Cloud Platform"
  type        = string
}

variable "region" {
  description = "Região GCP para alocação dos recursos (padrão: São Paulo)"
  type        = string
  default     = "southamerica-east1"
}

variable "zone" {
  description = "Zona GCP para a instância de computação"
  type        = string
  default     = "southamerica-east1-a"
}

variable "name" {
  description = "Prefixo padronizado para nomeação de recursos"
  type        = string
  default     = "chat-friends"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name))
    error_message = "O nome deve conter de 3 a 21 caracteres alfanuméricos minúsculos ou hífens."
  }
}

variable "machine_type" {
  description = "Tipo da máquina Compute Engine (e2-small: 1 vCPU, 2 GB RAM)"
  type        = string
  default     = "e2-small"
}

variable "boot_disk_size_gb" {
  description = "Tamanho do disco de boot em GB (pd-balanced)"
  type        = number
  default     = 20
}

variable "ssh_diagnostic_cidr" {
  description = "CIDR de origem autorizado para acesso SSH administrativo (padrão: IAP do GCP)"
  type        = string
  default     = "35.235.240.0/20"
}

variable "domain" {
  description = "Domínio configurado para o DuckDNS / TLS (ex: amigos.duckdns.org)"
  type        = string
  default     = ""
}

variable "labels" {
  description = "Rótulos para governança e tags de custo no GCP"
  type        = map(string)
  default = {
    application = "chat-friends"
    environment = "production"
    version     = "v2"
  }
}
