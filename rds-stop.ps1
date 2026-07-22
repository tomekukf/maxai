# Zatrzymuje instancje RDS maxai (oszczednosc na dev). AWS trzyma stop do 7 dni, potem sama wstaje.
# Uwaga: po zatrzymaniu Wyszukiwanie/Katalog/Statystyki/Import przestaja dzialac (logowanie dalej OK).
$ErrorActionPreference = 'Stop'
$Db = 'maxaistack-db5d02a0a9-jybapipmxkn3'
$Region = 'eu-central-1'

Write-Host "Zatrzymuje RDS $Db ($Region)..." -ForegroundColor Yellow
aws rds stop-db-instance --db-instance-identifier $Db --region $Region --query "DBInstance.DBInstanceStatus" --output text
Write-Host "Zlecono stop. Pelne zatrzymanie trwa kilka minut. Sprawdz: .\rds-status.ps1" -ForegroundColor Green
