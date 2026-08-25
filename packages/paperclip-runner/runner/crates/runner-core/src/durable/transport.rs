struct ParsedWsUrl {
    secure: bool,
    host: String,
    authority: String,
    port: u16,
    path: String,
}
fn parse_ws_url(input: &str) -> Result<ParsedWsUrl, DurableRunnerError> {
    let (secure, remainder, default_port) = if let Some(value) = input.strip_prefix("ws://") {
        (false, value, 80)
    } else if let Some(value) = input.strip_prefix("wss://") {
        (true, value, 443)
    } else {
        return Err(DurableRunnerError::invalid(
            "runner connect URL must use ws:// or wss://",
        ));
    };
    if remainder.is_empty()
        || remainder
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        || remainder.contains(['?', '#', '\\'])
    {
        return Err(DurableRunnerError::invalid(
            "WebSocket URL contains malformed, query, fragment, or path ambiguity",
        ));
    }
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, "/".to_owned()), |(authority, path)| {
            (authority, format!("/{path}"))
        });
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(DurableRunnerError::invalid(
            "WebSocket authority must not contain userinfo or encoding ambiguity",
        ));
    }
    let (host, port) = if authority.starts_with('[') {
        let closing = authority
            .find(']')
            .ok_or_else(|| DurableRunnerError::invalid("bracketed IPv6 authority is malformed"))?;
        let host = &authority[1..closing];
        let suffix = &authority[closing + 1..];
        let port = if suffix.is_empty() {
            default_port.to_string()
        } else {
            suffix
                .strip_prefix(':')
                .ok_or_else(|| DurableRunnerError::invalid("bracketed IPv6 authority is malformed"))?
                .to_owned()
        };
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| DurableRunnerError::invalid("bracketed WebSocket host must be IPv6"))?;
        (host, port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, default_port.to_string()), |(host, port)| {
                (host, port.to_owned())
            });
        if host.is_empty() || host.contains(':') {
            return Err(DurableRunnerError::invalid(
                "WebSocket host is empty or an unbracketed IPv6 literal",
            ));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .map_err(|error| DurableRunnerError::invalid(format!("invalid WebSocket port: {error}")))?;
    if port == 0 {
        return Err(DurableRunnerError::invalid("WebSocket port must be non-zero"));
    }
    Ok(ParsedWsUrl {
        secure,
        host: host.to_owned(),
        authority: authority.to_owned(),
        port,
        path,
    })
}

struct ResolvedWsTarget {
    secure: bool,
    host: String,
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
}

impl ResolvedWsTarget {
    fn resolve(input: &str) -> Result<Self, DurableRunnerError> {
        resolve_ws_target_with(input, |host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    }
}

enum RunnerTransportEndpoint {
    Dial(String),
    Listen { listener: TcpListener, path: String },
}

impl RunnerTransportEndpoint {
    fn new(input: &str) -> Result<Self, DurableRunnerError> {
        if let Some(remainder) = input.strip_prefix("listen://") {
            let (authority, path) = remainder.split_once('/').ok_or_else(|| {
                DurableRunnerError::invalid("runner_ingress_bind_conflict: listener path is required")
            })?;
            if authority != "0.0.0.0:43127" {
                return Err(DurableRunnerError::invalid(
                    "runner_ingress_bind_conflict: listener must bind 0.0.0.0:43127",
                ));
            }
            let path = format!("/{path}");
            let listener = TcpListener::bind(authority).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "runner_ingress_bind_conflict: failed to bind fixed listener: {error}"
                ))
            })?;
            listener.set_nonblocking(true).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "runner_ingress_bind_conflict: failed to configure listener: {error}"
                ))
            })?;
            return Ok(Self::Listen { listener, path });
        }
        Ok(Self::Dial(input.to_owned()))
    }

    fn open(
        &self,
        max_frame_bytes: usize,
        ca_bundle_path: Option<&Path>,
    ) -> Result<Option<WsClient>, DurableRunnerError> {
        match self {
            Self::Dial(url) => {
                // Resolve on every reconnect. TLS authenticates the configured
                // hostname, so a recovered connection is not pinned to a stale IP.
                let target = ResolvedWsTarget::resolve(url)?;
                WsClient::connect(&target, max_frame_bytes, ca_bundle_path).map(Some)
            }
            Self::Listen { listener, path } => match listener.accept() {
                Ok((stream, _peer)) => WsClient::accept(stream, path, max_frame_bytes).map(Some),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(error) => Err(DurableRunnerError::invalid(format!(
                    "runner ingress listener accept failed: {error}"
                ))),
            },
        }
    }
}

fn resolve_ws_target_with<F>(input: &str, resolver: F) -> Result<ResolvedWsTarget, DurableRunnerError>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    let parsed = parse_ws_url(input)?;
    let mut addresses = resolver(&parsed.host, parsed.port).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to resolve WebSocket destination: {error}"))
    })?;
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(DurableRunnerError::invalid(
            "WebSocket destination resolved to no addresses",
        ));
    }
    if !parsed.secure && addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err(DurableRunnerError::invalid(
            "plaintext WebSocket destinations must all be loopback (127.0.0.0/8 or ::1)",
        ));
    }
    Ok(ResolvedWsTarget {
        secure: parsed.secure,
        host: parsed.host,
        authority: parsed.authority,
        path: parsed.path,
        addresses,
    })
}

trait WsReadWrite: Read + Write {}
impl<T: Read + Write> WsReadWrite for T {}

struct WsClient {
    stream: Box<dyn WsReadWrite + Send>,
    mask_counter: u32,
    mask_outbound: bool,
    require_inbound_mask: bool,
    max_frame_bytes: usize,
    secure_channel: Option<SecureChannel>,
}

struct SecureChannel {
    send_cipher: Aes256Gcm,
    receive_cipher: Aes256Gcm,
    send_counter: u64,
    receive_counter: u64,
    session_id: String,
}

impl SecureChannel {
    fn new(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
    ) -> Result<Self, DurableRunnerError> {
        let session_binding = digest_domain(
            "paperclip-runner-session-binding-v1",
            &[challenge, server_proof, client_proof],
        );
        let send_key = hmac_domain(
            auth_key,
            "paperclip-runner-client-to-core-key-v1",
            &[&session_binding],
        );
        let receive_key = hmac_domain(
            auth_key,
            "paperclip-runner-core-to-client-key-v1",
            &[&session_binding],
        );
        Ok(Self {
            send_cipher: Aes256Gcm::new_from_slice(&send_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize transport encryption"))?,
            receive_cipher: Aes256Gcm::new_from_slice(&receive_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize transport decryption"))?,
            send_counter: 0,
            receive_counter: 0,
            session_id: format!("sha256:{}", hex_encode(&session_binding)),
        })
    }

    fn nonce(direction: &[u8; 4], counter: u64) -> [u8; 12] {
        let mut nonce = [0_u8; 12];
        nonce[..4].copy_from_slice(direction);
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    fn aad(&self, direction: &str, counter: u64) -> Vec<u8> {
        format!(
            "{SECURE_FRAME_SCHEMA}\0{}\0{direction}\0{counter}",
            self.session_id
        )
        .into_bytes()
    }

    fn encrypt(&mut self, plaintext: &[u8]) -> Result<Value, DurableRunnerError> {
        let counter = self.send_counter;
        let nonce = Self::nonce(b"P3C1", counter);
        let aad = self.aad("client_to_core", counter);
        let ciphertext = self
            .send_cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| DurableRunnerError::invalid("secure transport encryption failed"))?;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("secure transport send counter exhausted"))?;
        Ok(json!({
            "schema": SECURE_FRAME_SCHEMA,
            "counter": counter,
            "ciphertext": hex_encode(&ciphertext),
        }))
    }

    fn decrypt(&mut self, frame: &Value) -> Result<Value, DurableRunnerError> {
        if frame.get("schema").and_then(Value::as_str) != Some(SECURE_FRAME_SCHEMA) {
            return Err(DurableRunnerError::invalid(
                "unauthenticated plaintext control frame was rejected",
            ));
        }
        let counter = frame
            .get("counter")
            .and_then(Value::as_u64)
            .ok_or_else(|| DurableRunnerError::invalid("secure frame counter is required"))?;
        if counter != self.receive_counter {
            return Err(DurableRunnerError::invalid(
                "secure frame counter was replayed or arrived out of order",
            ));
        }
        let ciphertext = frame
            .get("ciphertext")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("secure frame ciphertext is required"))?;
        let ciphertext = hex_decode(ciphertext)?;
        let nonce = Self::nonce(b"P3S1", counter);
        let aad = self.aad("core_to_client", counter);
        let plaintext = self
            .receive_cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| DurableRunnerError::invalid("secure frame authentication failed"))?;
        self.receive_counter = self
            .receive_counter
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("secure transport receive counter exhausted"))?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            DurableRunnerError::invalid(format!("secure frame JSON is malformed: {error}"))
        })
    }
}

fn encode_frame(
    opcode: u8,
    payload: &[u8],
    mask: Option<[u8; 4]>,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, DurableRunnerError> {
    if payload.len() > max_frame_bytes {
        return Err(DurableRunnerError::invalid(
            "outbound WebSocket frame exceeds the limit",
        ));
    }
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        length if length <= 125 => frame.push(mask.map_or(0, |_| 0x80) | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(mask.map_or(0, |_| 0x80) | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(mask.map_or(0, |_| 0x80) | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    if let Some(mask) = mask {
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
    } else {
        frame.extend_from_slice(payload);
    }
    Ok(frame)
}

fn checked_inbound_frame_length(length: u64, max_frame_bytes: usize) -> Result<usize, DurableRunnerError> {
    let length = usize::try_from(length)
        .map_err(|_| DurableRunnerError::invalid("WebSocket frame length overflow"))?;
    if length > max_frame_bytes {
        return Err(DurableRunnerError::invalid(
            "inbound WebSocket frame exceeds the limit",
        ));
    }
    Ok(length)
}

fn read_http_headers(stream: &mut dyn Read, context: &str) -> Result<String, DurableRunnerError> {
    let mut headers = Vec::new();
    let mut byte = [0_u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= MAX_HTTP_HEADER_BYTES {
            return Err(DurableRunnerError::invalid(format!(
                "WebSocket {context} headers are too large"
            )));
        }
        stream.read_exact(&mut byte).map_err(|error| {
            DurableRunnerError::invalid(format!("WebSocket {context} failed: {error}"))
        })?;
        headers.push(byte[0]);
    }
    String::from_utf8(headers)
        .map_err(|error| DurableRunnerError::invalid(format!("invalid HTTP headers: {error}")))
}

fn tls_client_stream(
    stream: TcpStream,
    target: &ResolvedWsTarget,
    ca_bundle_path: Option<&Path>,
) -> Result<Box<dyn WsReadWrite + Send>, DurableRunnerError> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for certificate in native.certs {
        roots.add(certificate).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to load a platform trust root: {error}"))
        })?;
    }
    if let Some(path) = ca_bundle_path {
        let file = File::open(path).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to open runner CA bundle: {error}"))
        })?;
        let mut reader = io::BufReader::new(file);
        let mut added = 0_usize;
        for certificate in rustls_pemfile::certs(&mut reader) {
            roots.add(certificate.map_err(|error| {
                DurableRunnerError::invalid(format!("runner CA bundle is invalid: {error}"))
            })?)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("runner CA certificate is invalid: {error}"))
            })?;
            added += 1;
        }
        if added == 0 {
            return Err(DurableRunnerError::invalid(
                "runner CA bundle contains no certificates",
            ));
        }
    }
    if roots.is_empty() {
        return Err(DurableRunnerError::invalid(
            "no TLS trust roots are available",
        ));
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = ServerName::try_from(target.host.clone()).map_err(|_| {
        DurableRunnerError::invalid("runner WSS hostname is invalid for TLS verification")
    })?;
    let connection = ClientConnection::new(Arc::new(config), server_name)
        .map_err(|error| DurableRunnerError::invalid(format!("TLS setup failed: {error}")))?;
    Ok(Box::new(StreamOwned::new(connection, stream)))
}

impl WsClient {
    fn connect(
        target: &ResolvedWsTarget,
        max_frame_bytes: usize,
        ca_bundle_path: Option<&Path>,
    ) -> Result<Self, DurableRunnerError> {
        let stream = TcpStream::connect(target.addresses.as_slice())
            .map_err(|error| DurableRunnerError::invalid(format!("WebSocket connect failed: {error}")))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let mut stream: Box<dyn WsReadWrite + Send> = if target.secure {
            tls_client_stream(stream, target, ca_bundle_path)?
        } else {
            Box::new(stream)
        };
        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            target.path,
            target.authority,
            STATIC_WEBSOCKET_KEY
        )
        .into_bytes();
        let write_result = stream.write_all(&request).and_then(|_| stream.flush());
        // Keep the request buffer short-lived even though it contains only public data.
        // Authentication capabilities never cross the socket.
        request.fill(0);
        request.clear();
        write_result.map_err(|error| {
            DurableRunnerError::invalid(format!("WebSocket upgrade write failed: {error}"))
        })?;

        let response = read_http_headers(stream.as_mut(), "upgrade response")?;
        if !response.starts_with("HTTP/1.1 101 ") {
            let status = response
                .lines()
                .next()
                .unwrap_or("HTTP response unavailable");
            return Err(DurableRunnerError::invalid(format!(
                "WebSocket authentication or upgrade rejected: {status}"
            )));
        }
        let accept_valid = response.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("sec-websocket-accept")
                    && value.trim() == STATIC_WEBSOCKET_ACCEPT
            })
        });
        if !accept_valid {
            return Err(DurableRunnerError::invalid(
                "WebSocket server returned an invalid acceptance proof",
            ));
        }
        Ok(Self {
            stream,
            mask_counter: 1,
            mask_outbound: true,
            require_inbound_mask: false,
            max_frame_bytes,
            secure_channel: None,
        })
    }

    fn accept(
        mut stream: TcpStream,
        expected_path: &str,
        max_frame_bytes: usize,
    ) -> Result<Self, DurableRunnerError> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let request = read_http_headers(&mut stream, "upgrade request")?;
        let mut lines = request.split("\r\n");
        let request_line = lines.next().unwrap_or_default();
        if request_line != format!("GET {expected_path} HTTP/1.1") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return Err(DurableRunnerError::invalid(
                "runner listener rejected an unrelated HTTP path",
            ));
        }
        let mut websocket_key: Option<&str> = None;
        let mut upgrade = false;
        let mut connection_upgrade = false;
        let mut version = false;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            if name.eq_ignore_ascii_case("sec-websocket-key") {
                websocket_key = Some(value);
            } else if name.eq_ignore_ascii_case("upgrade") {
                upgrade = value.eq_ignore_ascii_case("websocket");
            } else if name.eq_ignore_ascii_case("connection") {
                connection_upgrade = value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"));
            } else if name.eq_ignore_ascii_case("sec-websocket-version") {
                version = value == "13";
            } else if name.eq_ignore_ascii_case("sec-websocket-extensions") {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                return Err(DurableRunnerError::invalid(
                    "runner listener does not support WebSocket compression",
                ));
            }
        }
        let websocket_key = websocket_key.filter(|value| !value.is_empty()).ok_or_else(|| {
            DurableRunnerError::invalid("runner listener requires a WebSocket key")
        })?;
        if !upgrade || !connection_upgrade || !version {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return Err(DurableRunnerError::invalid(
                "runner listener rejected an ordinary HTTP request",
            ));
        }
        let mut hasher = Sha1::new();
        hasher.update(websocket_key.as_bytes());
        hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        let accept = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
        stream
            .write_all(
                format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                .as_bytes(),
            )
            .and_then(|_| stream.flush())
            .map_err(|error| {
                DurableRunnerError::invalid(format!("WebSocket upgrade response failed: {error}"))
            })?;
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        Ok(Self {
            stream: Box::new(stream),
            mask_counter: 1,
            mask_outbound: false,
            require_inbound_mask: true,
            max_frame_bytes,
            secure_channel: None,
        })
    }

    fn send_json(&mut self, value: &Value) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            DurableRunnerError::invalid(format!("frame serialization failed: {error}"))
        })?;
        let frame = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("secure transport is not authenticated"))?
            .encrypt(&bytes)?;
        self.send_plain_json(&frame)
    }

    fn send_plain_json(&mut self, value: &Value) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            DurableRunnerError::invalid(format!("frame serialization failed: {error}"))
        })?;
        self.send_frame(0x1, &bytes)
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), DurableRunnerError> {
        let mask = self.mask_outbound.then(|| {
            let mask = self.mask_counter.to_be_bytes();
            self.mask_counter = self.mask_counter.wrapping_add(1);
            mask
        });
        let frame = encode_frame(opcode, payload, mask, self.max_frame_bytes)?;
        self.stream
            .write_all(&frame)
            .and_then(|_| self.stream.flush())
            .map_err(|error| DurableRunnerError::invalid(format!("WebSocket frame write failed: {error}")))
    }

    fn receive_json(&mut self) -> Result<Option<Value>, DurableRunnerError> {
        let Some(frame) = self.receive_plain_json()? else {
            return Ok(None);
        };
        let value = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("secure transport is not authenticated"))?
            .decrypt(&frame)?;
        Ok(Some(value))
    }

    fn receive_plain_json(&mut self) -> Result<Option<Value>, DurableRunnerError> {
        loop {
            let mut header = [0_u8; 2];
            match self.stream.read_exact(&mut header) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(error) => {
                    return Err(DurableRunnerError::invalid(format!(
                        "WebSocket connection closed: {error}"
                    )))
                }
            }
            if header[0] & 0x80 == 0 || header[0] & 0x70 != 0 {
                return Err(DurableRunnerError::invalid(
                    "fragmented or extension WebSocket frames are not supported",
                ));
            }
            let opcode = header[0] & 0x0f;
            let masked = header[1] & 0x80 != 0;
            if masked != self.require_inbound_mask {
                return Err(DurableRunnerError::invalid(
                    "WebSocket frame masking direction is invalid",
                ));
            }
            let mut length = u64::from(header[1] & 0x7f);
            if length == 126 {
                let mut extended = [0_u8; 2];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0_u8; 8];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                length = u64::from_be_bytes(extended);
            }
            let length = checked_inbound_frame_length(length, self.max_frame_bytes)?;
            if matches!(opcode, 0x8..=0xA) && length > 125 {
                return Err(DurableRunnerError::invalid(
                    "WebSocket control frame exceeds 125 bytes",
                ));
            }
            let mut mask = [0_u8; 4];
            if masked {
                self.stream
                    .read_exact(&mut mask)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            }
            let mut payload = vec![0_u8; length];
            self.stream
                .read_exact(&mut payload)
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            match opcode {
                0x1 => {
                    let value = serde_json::from_slice(&payload).map_err(|error| {
                        DurableRunnerError::invalid(format!("malformed WebSocket JSON: {error}"))
                    })?;
                    return Ok(Some(value));
                }
                0x8 => return Err(DurableRunnerError::invalid("WebSocket peer closed the connection")),
                0x9 => self.send_frame(0xA, &payload)?,
                0xA => {}
                _ => return Err(DurableRunnerError::invalid("unsupported WebSocket frame opcode")),
            }
        }
    }

    fn enable_secure_channel(&mut self, channel: SecureChannel) {
        self.secure_channel = Some(channel);
    }
}

fn authentication_hello_envelope(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential_id: &str,
    client_nonce: &str,
) -> Value {
    let unacked_range = state
        .outbox
        .first()
        .zip(state.outbox.last())
        .map(|(first, last)| json!([first.source_seq, last.source_seq]));
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_hello",
        "payload": {
            "credentialId": credential_id,
            "clientNonce": client_nonce,
            "protocolMin": 1,
            "protocolMax": 1,
            "runnerInstanceId": state.runner_instance_id,
            "runnerVersion": config.runner_version,
            "runnerDigest": config.runner_digest,
            "environmentLeaseId": state.environment_lease_id,
            "runId": state.run_id,
            "normalizedSessionId": state.normalized_session_id,
            "turnId": state.turn_id,
            "itemId": state.item_id,
            "sandboxProvider": "standalone_mock",
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": "redacted-standalone-runner",
            },
            "drivers": [{
                "kind": "fake",
                "version": "1.0.0",
                "capabilities": { "resume": true, "interrupt": true },
            }],
            "resume": {
                "lastControllerCommandSeq": state.last_controller_command_seq,
                "nextSourceEventSeq": state.next_source_seq,
                "ackedSourceSeq": state.acked_source_seq,
                "unackedEventRange": unacked_range,
            },
        },
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, DurableRunnerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DurableRunnerError::invalid(format!("{field} is required")))
}

fn authenticate_transport(
    client: &mut WsClient,
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential: &CredentialMaterial,
    credential_kind: &str,
    expected_lease_id: Option<&str>,
    expected_expires_at_unix_ms: Option<u64>,
    expected_revocation_epoch: Option<u64>,
) -> Result<(), DurableRunnerError> {
    let client_nonce = random_suffix()?;
    client.send_plain_json(&authentication_hello_envelope(
        state,
        config,
        &credential.credential_id,
        &client_nonce,
    ))?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(2))
        .ok_or_else(|| DurableRunnerError::invalid("transport authentication deadline overflowed"))?;
    let challenge = loop {
        match client.receive_plain_json()? {
            Some(value) => break value,
            None if Instant::now() < deadline => continue,
            None => return Err(DurableRunnerError::invalid("transport authentication timed out")),
        }
    };
    if challenge.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || challenge.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || challenge.get("kind").and_then(Value::as_str) != Some("auth_challenge")
    {
        return Err(DurableRunnerError::invalid(
            "core did not return an authenticated transport challenge",
        ));
    }
    let payload = challenge
        .get("payload")
        .ok_or_else(|| DurableRunnerError::invalid("authentication challenge payload is required"))?;
    for (field, expected) in [
        ("credentialId", credential.credential_id.as_str()),
        ("credentialKind", credential_kind),
        ("clientNonce", client_nonce.as_str()),
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
        ("turnId", state.turn_id.as_str()),
        ("itemId", state.item_id.as_str()),
        ("runnerVersion", config.runner_version.as_str()),
        ("runnerDigest", config.runner_digest.as_str()),
    ] {
        if required_string(payload, field)? != expected {
            return Err(DurableRunnerError::invalid(format!(
                "authentication challenge {field} does not match the requested session"
            )));
        }
    }
    required_string(payload, "serverNonce")?;
    required_string(payload, "credentialExpiresAt")?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge selected an unsupported protocol",
        ));
    }
    let expires_at_unix_ms = payload
        .get("credentialExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            DurableRunnerError::invalid("authentication challenge credential expiry is required")
        })?;
    if expires_at_unix_ms <= current_unix_ms()? {
        return Err(DurableRunnerError::invalid(
            "transport credential expired before authentication completed",
        ));
    }
    if expected_expires_at_unix_ms.is_some_and(|expected| expected != expires_at_unix_ms) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge changed the connection lease expiry",
        ));
    }
    let revocation_epoch = payload
        .get("revocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("authentication revocation epoch is required"))?;
    if expected_revocation_epoch.is_some_and(|expected| expected != revocation_epoch) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge changed the connection lease revocation epoch",
        ));
    }
    match (expected_lease_id, payload.get("credentialLeaseId")) {
        (Some(expected), Some(Value::String(actual))) if actual == expected => {}
        (None, Some(Value::Null)) => {}
        _ => {
            return Err(DurableRunnerError::invalid(
                "authentication challenge lease identity does not match the credential",
            ))
        }
    }

    let server_proof = required_string(payload, "serverProof")?.to_owned();
    let mut authenticated_payload = payload.clone();
    authenticated_payload
        .as_object_mut()
        .ok_or_else(|| DurableRunnerError::invalid("authentication challenge payload must be an object"))?
        .remove("serverProof");
    let canonical_challenge = canonical_json(&authenticated_payload);
    verify_hmac_hex(
        &credential.auth_key,
        "paperclip-runner-server-proof-v1",
        &[canonical_challenge.as_bytes()],
        &server_proof,
    )?;
    let client_proof = hex_encode(&hmac_domain(
        &credential.auth_key,
        "paperclip-runner-client-proof-v1",
        &[canonical_challenge.as_bytes(), server_proof.as_bytes()],
    ));
    client.send_plain_json(&json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_response",
        "payload": {
            "credentialId": credential.credential_id,
            "clientNonce": client_nonce,
            "serverNonce": required_string(payload, "serverNonce")?,
            "clientProof": client_proof,
        },
    }))?;
    let secure_channel = SecureChannel::new(
        &credential.auth_key,
        canonical_challenge.as_bytes(),
        server_proof.as_bytes(),
        client_proof.as_bytes(),
    )?;
    client.enable_secure_channel(secure_channel);
    Ok(())
}

fn send_outbox(
    client: &mut WsClient,
    state: &DurableRunnerState,
    sent_source_seq: &mut u64,
) -> Result<(), DurableRunnerError> {
    for event in &state.outbox {
        if event.source_seq <= *sent_source_seq {
            continue;
        }
        client.send_json(&event.envelope)?;
        *sent_source_seq = event.source_seq;
    }
    Ok(())
}

struct ConnectionMetadata {
    connection_id: String,
    lease_id: String,
    lease_expires_at_unix_ms: u64,
    revocation_epoch: u64,
}

fn validate_control_identity(
    value: &Value,
    state: &DurableRunnerState,
    connection: Option<&ConnectionMetadata>,
) -> Result<(), DurableRunnerError> {
    if value.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
    {
        return Err(DurableRunnerError::invalid(
            "control envelope protocol identity is invalid",
        ));
    }
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
    ] {
        let actual = required_string(value, field)?;
        if actual != expected {
            return Err(DurableRunnerError::invalid(format!(
                "control envelope {field} does not match the authenticated session (expected {expected}, received {actual})"
            )));
        }
    }
    let current_attachment_matches = required_string(value, "runId")? == state.run_id
        && required_string(value, "turnId")? == state.turn_id
        && required_string(value, "itemId")? == state.item_id;
    let prior_ack_matches = value.get("kind").and_then(Value::as_str) == Some("ack")
        && state.previous_attachment_identity.as_ref().is_some_and(|prior| {
            value.get("runId").and_then(Value::as_str) == Some(prior.run_id.as_str())
                && value.get("turnId").and_then(Value::as_str) == Some(prior.turn_id.as_str())
                && value.get("itemId").and_then(Value::as_str) == Some(prior.item_id.as_str())
        });
    if !current_attachment_matches && !prior_ack_matches {
        return Err(DurableRunnerError::invalid(
            "control envelope run attachment does not match the authenticated session",
        ));
    }
    if let Some(connection) = connection {
        if required_string(value, "connectionId")? != connection.connection_id
            || required_string(value, "connectionLeaseId")? != connection.lease_id
        {
            return Err(DurableRunnerError::invalid(
                "control envelope connection lease identity does not match the authenticated session",
            ));
        }
        if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
            return Err(DurableRunnerError::invalid(
                "connection lease expired before the control envelope was applied",
            ));
        }
    }
    Ok(())
}

fn validate_welcome<'a>(
    value: &'a Value,
    state: &DurableRunnerState,
) -> Result<(&'a Value, ConnectionMetadata), DurableRunnerError> {
    validate_control_identity(value, state, None)?;
    if value.get("kind").and_then(Value::as_str) != Some("welcome") {
        return Err(DurableRunnerError::invalid("expected a PRP v1 welcome envelope"));
    }
    let connection_id = required_string(value, "connectionId")?.to_owned();
    let lease_id = required_string(value, "connectionLeaseId")?.to_owned();
    let payload = value
        .get("payload")
        .ok_or_else(|| DurableRunnerError::invalid("welcome payload is required"))?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "core selected an unsupported protocol version",
        ));
    }
    if required_string(payload, "connectionLeaseId")? != lease_id {
        return Err(DurableRunnerError::invalid(
            "welcome lease identity is internally inconsistent",
        ));
    }
    required_string(payload, "connectionLeaseExpiresAt")?;
    let lease_expires_at_unix_ms = payload
        .get("connectionLeaseExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome lease expiry is required"))?;
    if lease_expires_at_unix_ms <= current_unix_ms()? {
        return Err(DurableRunnerError::invalid(
            "welcome carried an already-expired connection lease",
        ));
    }
    let revocation_epoch = payload
        .get("connectionLeaseRevocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome revocation epoch is required"))?;
    let binding = payload
        .get("leaseBinding")
        .ok_or_else(|| DurableRunnerError::invalid("welcome lease binding is required"))?;
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
    ] {
        if required_string(binding, field)? != expected {
            return Err(DurableRunnerError::invalid(format!(
                "welcome lease binding {field} does not match the authenticated session"
            )));
        }
    }
    if binding.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "welcome lease binding protocol is invalid",
        ));
    }
    Ok((
        payload,
        ConnectionMetadata {
            connection_id,
            lease_id,
            lease_expires_at_unix_ms,
            revocation_epoch,
        },
    ))
}
