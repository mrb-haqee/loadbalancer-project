# Runner pemicu Run k6 dari dashboard Grafana.
#
# Kenapa image sendiri: image grafana/k6 tidak punya server HTTP (busybox httpd
# dicopot), dan menambah Docker socket ke stack monitoring terlalu berisiko.
# Alpine dipilih sama dengan basis image k6 (musl) supaya binary k6 bisa dipakai
# langsung tanpa build ulang.
FROM grafana/k6:2.4.0 AS k6

FROM alpine:3.24

# httpd + CGI ada di paket busybox-extras, bukan busybox inti.
RUN apk add --no-cache busybox-extras

COPY --from=k6 /usr/bin/k6 /usr/bin/k6
COPY docker/k6-runner/trigger /www/cgi-bin/trigger
RUN chmod +x /www/cgi-bin/trigger

EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
