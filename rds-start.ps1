# Uruchamia instancje RDS maxai (przed praca/demem). Pelny start trwa ~1-3 min.
$ErrorActionPreference = 'Stop'
$Db = 'maxaistack-db5d02a0a9-jybapipmxkn3'
$Region = 'eu-central-1'

Write-Host "Uruchamiam RDS $Db ($Region)..." -ForegroundColor Yellow
aws rds start-db-instance --db-instance-identifier $Db --region $Region --query "DBInstance.DBInstanceStatus" --output text
Write-Host "Zlecono start. Baza gotowa gdy status = 'available' (sprawdz: .\rds-status.ps1)." -ForegroundColor Green
