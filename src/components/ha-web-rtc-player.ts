import {
  css,
  CSSResultGroup,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
} from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { ifDefined } from "lit/directives/if-defined";
import { fireEvent } from "../common/dom/fire_event";
import {
  addWebRtcCandidate,
  fetchWebRtcClientConfiguration,
  WebRtcAnswer,
  webRtcOffer,
  WebRtcOfferEvent,
} from "../data/camera";
import type { HomeAssistant } from "../types";
import "./ha-alert";

/**
 * A WebRTC stream is established by first sending an offer through a signal
 * path via an integration. An answer is returned, then the rest of the stream
 * is handled entirely client side.
 */
@customElement("ha-web-rtc-player")
class HaWebRtcPlayer extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property() public entityid!: string;

  @property({ type: Boolean, attribute: "controls" })
  public controls = false;

  @property({ type: Boolean, attribute: "muted" })
  public muted = false;

  @property({ type: Boolean, attribute: "autoplay" })
  public autoPlay = false;

  @property({ type: Boolean, attribute: "playsinline" })
  public playsInline = false;

  @property({ attribute: "poster-url" }) public posterUrl?: string;

  @state() private _error?: string;

  @query("#remote-stream", true) private _videoEl!: HTMLVideoElement;

  private _peerConnection?: RTCPeerConnection;

  private _remoteStream?: MediaStream;

  protected override render(): TemplateResult {
    if (this._error) {
      return html`<ha-alert alert-type="error">${this._error}</ha-alert>`;
    }
    return html`
      <video
        id="remote-stream"
        ?autoplay=${this.autoPlay}
        .muted=${this.muted}
        ?playsinline=${this.playsInline}
        ?controls=${this.controls}
        poster=${ifDefined(this.posterUrl)}
        @loadeddata=${this._loadedData}
      ></video>
    `;
  }

  public override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this._startWebRtc();
    }
  }

  public override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanUp();
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("entityid")) {
      return;
    }
    this._startWebRtc();
  }

  private async _startWebRtc(): Promise<void> {
    this._error = undefined;

    const clientConfig = await fetchWebRtcClientConfiguration(
      this.hass,
      this.entityid
    );

    const peerConnection = new RTCPeerConnection(clientConfig.configuration);

    if (clientConfig.dataChannel) {
      // Some cameras (such as nest) require a data channel to establish a stream
      // however, not used by any integrations.
      peerConnection.createDataChannel(clientConfig.dataChannel);
    }
    peerConnection.addTransceiver("audio", { direction: "recvonly" });
    peerConnection.addTransceiver("video", { direction: "recvonly" });

    let candidates = ""; // Build an Offer SDP string with ice candidates
    this._candidatesList = [];

    peerConnection.addEventListener("icecandidate", async (event) => {
      if (!event.candidate?.candidate) {
        // Gathering complete
        return;
      }
      if (this._sessionId) {
        addWebRtcCandidate(
          this.hass,
          this.entityid,
          this._sessionId,
          event.candidate.candidate
        );
      } else if (this._unsub) {
        this._candidatesList.push(event.candidate.candidate);
      } else {
        candidates += `a=${event.candidate.candidate}\r\n`;
      }
    });

    const offerOptions: RTCOfferOptions = {
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    };
    const offer: RTCSessionDescriptionInit =
      await peerConnection.createOffer(offerOptions);
    await peerConnection.setLocalDescription(offer);

    const offer_sdp = offer.sdp! + candidates;

    this._peerConnection = peerConnection;

    try {
      this._unsub = webRtcOffer(this.hass, this.entityid, offer_sdp, (event) =>
        this._handleOfferEvent(event)
      );
    } catch (err: any) {
      this._error = "Failed to start WebRTC stream: " + err.message;
      peerConnection.close();
      return;
    }

    // Setup callbacks to render remote stream once media tracks are discovered.
    const remoteStream = new MediaStream();
    peerConnection.addEventListener("track", (event) => {
      remoteStream.addTrack(event.track);
      this._videoEl.srcObject = remoteStream;
    });
    this._remoteStream = remoteStream;
  }

  private _handleOfferEvent(event: WebRtcOfferEvent) {
    if (event.type === "session_id") {
      this._sessionId = event.session_id;
      this._candidatesList.forEach((candidate) =>
        addWebRtcCandidate(
          this.hass,
          this.entityid,
          event.session_id,
          candidate
        )
      );
      this._candidatesList = [];
    }
    if (event.type === "answer") {
      this._handleAnswer(event);
    }
    if (event.type === "candidate") {
      this._peerConnection?.addIceCandidate(
        new RTCIceCandidate({ candidate: event.candidate, sdpMid: "0" })
      );
    }
  }

  private async _handleAnswer(event: WebRtcAnswer) {
    // Initiate the stream with the remote device
    const remoteDesc = new RTCSessionDescription({
      type: "answer",
      sdp: event.answer,
    });
    try {
      await this._peerConnection?.setRemoteDescription(remoteDesc);
    } catch (err: any) {
      this._error = "Failed to connect WebRTC stream: " + err.message;
      this._peerConnection?.close();
    }
  }

  private _cleanUp() {
    if (this._remoteStream) {
      this._remoteStream.getTracks().forEach((track) => {
        track.stop();
      });
      this._remoteStream = undefined;
    }
    if (this._videoEl) {
      this._videoEl.removeAttribute("src");
      this._videoEl.load();
    }
    if (this._peerConnection) {
      this._peerConnection.close();
      this._peerConnection = undefined;
    }
  }

  private _loadedData() {
    // @ts-ignore
    fireEvent(this, "load");
  }

  static get styles(): CSSResultGroup {
    return css`
      :host,
      video {
        display: block;
      }

      video {
        width: 100%;
        max-height: var(--video-max-height, calc(100vh - 97px));
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-web-rtc-player": HaWebRtcPlayer;
  }
}
