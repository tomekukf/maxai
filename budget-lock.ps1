# Reczne, NATYCHMIASTOWE odciecie Bedrock (ochrona budzetu) - dopina polityke deny do rol Lambd maxai.
# Skutek: Wyszukiwanie/Detekcja/Ekstrakcja padaja (brak Bedrock). Katalog i logowanie dzialaja. Cofniecie: .\budget-unlock.ps1
$ErrorActionPreference = 'Stop'
$Policy = 'arn:aws:iam::652069863576:policy/maxai-DenyBedrock'
$Roles = @(
  'MaxaiStack-SearchFnServiceRoleB6733184-5L52ZS1rCktd',
  'MaxaiStack-DetectFnServiceRole6234ABC3-ytqteRqvS6Rz',
  'MaxaiStack-ExtractFnServiceRole6E53F47C-eI4QpJT57gxH',
  'MaxaiStack-ProductsFnServiceRoleA9750689-sTZTpNHmFpZk'
)
foreach ($r in $Roles) {
  aws iam attach-role-policy --role-name $r --policy-arn $Policy
  Write-Host "deny-Bedrock -> $r" -ForegroundColor Yellow
}
Write-Host "Bedrock ODCIETY. Wyszukiwanie wylaczone. Cofniesz: .\budget-unlock.ps1" -ForegroundColor Green
