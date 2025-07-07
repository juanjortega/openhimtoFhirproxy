# openhimtoFhirproxy

[feed-watcher.py]
         |
     (POST con UUID)
         |
         v
[nuevo mediador /event]
         |
(usa fhir-proxy para obtener recursos)
         |
    para cada recurso:
         |
         v
(PUT al FHIR_NODE_URL:8080/fhir/Patient/{id}, Encounter/{id}, etc.)

