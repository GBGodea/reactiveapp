param(
  [string]$BaseUrl = "http://localhost:8080",
  [int]$From = 1,
  [int]$To = 10000,
  [int]$Concurrency = 50
)

$types = @("THERMOMETER","HUMIDITY","MOTION")
$headers = @{ "Content-Type" = "application/json" }

$From..$To | ForEach-Object -Parallel {
  $i = $_
  $type = ($using:types | Get-Random)

  $payload = @{
    name     = "$type-$('{0:00000}' -f $i)"
    type     = $type
    deviceId = "$i"
    period   = "PT1S"
  } | ConvertTo-Json -Compress

  try {
    # Не падаем на 409/400 — забираем статус код
    $resp = Invoke-WebRequest -Uri "$using:BaseUrl/iot/add" -Method Post -Headers $using:headers -Body $payload -SkipHttpErrorCheck
    if ($resp.StatusCode -eq 409) {
      # уже существует — норм
    } elseif ($resp.StatusCode -lt 200 -or $resp.StatusCode -ge 300) {
      Write-Host "failed deviceId=$i http=$($resp.StatusCode)"
    }
    if (($i % 500) -eq 0) { Write-Host "created up to deviceId=$i" }
  } catch {
    Write-Host "failed deviceId=$i : $($_.Exception.Message)"
  }
} -ThrottleLimit $Concurrency
