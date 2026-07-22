# Cofa odciecie Bedrock (przywraca wyszukiwanie) - odpina polityke deny od rol Lambd maxai.
# Uzyj po tym, jak akcja budzetu (85%) lub .\budget-lock.ps1 zablokowaly Bedrock i chcesz wznowic.
$ErrorActionPreference = 'Stop'
$Policy = 'arn:aws:iam::652069863576:policy/maxai-DenyBedrock'
$Roles = @(
  'MaxaiStack-SearchFnServiceRoleB6733184-5L52ZS1rCktd',
  'MaxaiStack-DetectFnServiceRole6234ABC3-ytqteRqvS6Rz',
  'MaxaiStack-ExtractFnServiceRole6E53F47C-eI4QpJT57gxH',
  'MaxaiStack-ProductsFnServiceRoleA9750689-sTZTpNHmFpZk'
)
foreach ($r in $Roles) {
  try { aws iam detach-role-policy --role-name $r --policy-arn $Policy; Write-Host "odpieto <- $r" -ForegroundColor Green }
  catch { Write-Host "juz odpiete / brak: $r" -ForegroundColor DarkGray }
}
Write-Host "Bedrock PRZYWROCONY. Wyszukiwanie znow dziala." -ForegroundColor Green
