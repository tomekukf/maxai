# Pokazuje stan instancji RDS maxai (available / stopped / starting / stopping...).
$ErrorActionPreference = 'Stop'
$Db = 'maxaistack-db5d02a0a9-jybapipmxkn3'
$Region = 'eu-central-1'

$status = aws rds describe-db-instances --db-instance-identifier $Db --region $Region --query "DBInstances[0].DBInstanceStatus" --output text
Write-Host "RDS $Db : $status"
if ($status -eq 'available') { Write-Host "Baza gotowa - apka w pelni dziala." -ForegroundColor Green }
elseif ($status -eq 'stopped') { Write-Host "Baza zatrzymana - Wyszukiwanie/Katalog nie dzialaja. Uruchom: .\rds-start.ps1" -ForegroundColor Yellow }
else { Write-Host "Stan przejsciowy - poczekaj chwile i sprawdz ponownie." -ForegroundColor Yellow }
