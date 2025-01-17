import { WebPlugin } from '@capacitor/core';
import { BarcodeFormat, BrowserQRCodeReader, IScannerControls } from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';
import { NotFoundException, ChecksumException, FormatException } from '@zxing/library';

import {
  BarcodeScannerPlugin,
  ScanOptions,
  ScanResult,
  CheckPermissionOptions,
  CheckPermissionResult,
  StopScanOptions,
  TorchStateResult,
  CameraDirection,
  IScanResultWithContent,
} from './definitions';

export class ScanCanceled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanCanceled';
  }
}

export class BarcodeScannerWeb extends WebPlugin implements BarcodeScannerPlugin {
  private static _FORWARD = { facingMode: 'user' };
  private static _BACK = { facingMode: 'environment' };
  private _formats: number[] = [];
  private _controls: IScannerControls | null = null;
  private _torchState = false;
  private _video: HTMLVideoElement | null = null;
  private _videoPromise: Promise<void> | null = null;
  private _video_nonce: number = 0;
  private _options: ScanOptions | null = null;
  private _backgroundColor: string | null = null;
  private _facingMode: MediaTrackConstraints = BarcodeScannerWeb._BACK;

  async prepare(): Promise<void> {
    await this._getVideoElement();
    return;
  }

  async hideBackground(): Promise<void> {
    this._backgroundColor = document.documentElement.style.backgroundColor;
    document.documentElement.style.backgroundColor = 'transparent';
    return;
  }

  async showBackground(): Promise<void> {
    document.documentElement.style.backgroundColor = this._backgroundColor || '';
    return;
  }

  async startScan(_options: ScanOptions): Promise<ScanResult> {
    this._options = _options;
    this._formats = [];
    _options?.targetedFormats?.forEach((format) => {
      const formatIndex = Object.keys(BarcodeFormat).indexOf(format);
      if (formatIndex >= 0) {
        this._formats.push(0);
      } else {
        console.error(format, 'is not supported on web');
      }
    });
    if (!!_options?.cameraDirection) {
      this._facingMode = _options.cameraDirection === CameraDirection.BACK ? BarcodeScannerWeb._BACK : BarcodeScannerWeb._FORWARD;
    }
    const video = await this._getVideoElement();
    const scanResult = await this._getFirstResultFromReader(video);
    if (!scanResult) throw this.unavailable('Missing scan result');
    return scanResult;
  }

  async startScanning(_options: ScanOptions, _callback: any): Promise<string> {
    throw this.unimplemented('Not implemented on web.');
  }

  async pauseScanning(): Promise<void> {
    if (this._controls) {
      this._controls.stop();
      this._controls = null;
    }
  }

  async resumeScanning(): Promise<void> {
    const video = await this._getVideoElement();
    await this._getFirstResultFromReader(video);
    return;
  }

  async stopScan(_options?: StopScanOptions): Promise<void> {
    this._stop();
    if (this._controls) {
      this._controls.stop();
      this._controls = null;
    }
  }

  async checkPermission(_options: CheckPermissionOptions): Promise<CheckPermissionResult> {
    if (typeof navigator === 'undefined' || !navigator.permissions) {
      throw this.unavailable('Permissions API not available in this browser');
    }

    try {
      // https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query
      // the specific permissions that are supported varies among browsers that implement the
      // permissions API, so we need a try/catch in case 'camera' is invalid
      const permission = await window.navigator.permissions.query({
        name: 'camera' as any,
      });
      if (permission.state === 'prompt') {
        return {
          neverAsked: true,
        };
      }
      if (permission.state === 'denied') {
        return {
          denied: true,
        };
      }
      if (permission.state === 'granted') {
        return {
          granted: true,
        };
      }
      return {
        unknown: true,
      };
    } catch {
      throw this.unavailable('Camera permissions are not available in this browser');
    }
  }

  async openAppSettings(): Promise<void> {
    throw this.unavailable('App settings are not available in this browser');
  }

  async disableTorch(): Promise<void> {
    if (this._controls && this._controls.switchTorch) {
      this._controls.switchTorch(false);
      this._torchState = false;
    }
  }

  async enableTorch(): Promise<void> {
    if (this._controls && this._controls.switchTorch) {
      this._controls.switchTorch(true);
      this._torchState = true;
    }
  }

  async toggleTorch(): Promise<void> {
    if (this._controls && this._controls.switchTorch) {
      this._controls.switchTorch(true);
    }
  }

  async getTorchState(): Promise<TorchStateResult> {
    return { isEnabled: this._torchState };
  }

  private async _getVideoElement(): Promise<HTMLVideoElement> {
    if (!this._video) {
      if (!this._videoPromise) {
        this._videoPromise = (async () => {
          const video = await this._startVideo();
          const parent = document.createElement('div');
          parent.setAttribute(
            'style',
            'position:absolute; top: 0; left: 0; width:100%; height: 100%; background-color: black;'
          );
          parent.appendChild(video);
          document.body.appendChild(parent);
          this._video = video;
          this._videoPromise = null;
        })();
      }
      await this._videoPromise;
      if (this._video === null) {
        throw new Error('Unexpected null value for _video');
      }
    }
    return this._video;
  }

  private async _getFirstResultFromReader(video: HTMLVideoElement) {
    let hints;
    if (this._formats.length) {
      hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, this._formats);
    }
    const reader = new BrowserQRCodeReader(hints);
    let result;
    try {
      result = await new Promise<IScanResultWithContent>(async (resolve, reject) => {
        this._controls = await reader.decodeFromVideoElement(video, (result, error) => {
          if (error) {
            if (
              error instanceof NotFoundException ||
              error instanceof ChecksumException ||
              error instanceof FormatException
            ) {
              console.warn(`Ignoring exception ${error.name} while reading QRCode`);
              return;
            }

            reject(error);
            return;
          }
          // No errors...
          if (!result) {
            reject(new Error('Unexpectedly called with no error nor result'));
            return;
          }
          let resultText = result.getText();
          if (!resultText) {
            reject(new Error('Unexpectedly called with no error nor text result'));
            return;
          }
          resolve({
            hasContent: true,
            content: resultText,
            format: result.getBarcodeFormat().toString(),
          });
        });
      });
    } finally {
      if (this._controls) {
        this._controls.stop();
        this._controls = null;
        this._stop();
      }
    }
    return result;
  }

  private async _startVideo(): Promise<HTMLVideoElement> {
    let video_nonce = this._video_nonce;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('No mediaDevices supported');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true,
    });
    // Stop any existing stream so we can request media with different constraints based on user input
    stopStream(stream);
    if (video_nonce != this._video_nonce) {
      // stop was called
      throw new ScanCanceled('Canceled after stopping hypothetic previous scan');
    }

    if (document.getElementById('video')) throw new Error('Camera already started');

    let video = document.createElement('video');
    video.id = 'video';
    // Don't flip video feed if camera is rear facing
    if (this._options?.cameraDirection !== CameraDirection.BACK) {
      video.setAttribute('style', '-webkit-transform: scaleX(-1); transform: scaleX(-1); width:100%; height: 100%;');
    } else {
      video.setAttribute('style', 'width:100%; height: 100%;');
    }

    const userAgent = navigator.userAgent.toLowerCase();
    const isSafari = userAgent.includes('safari') && !userAgent.includes('chrome');

    // Safari on iOS needs to have the autoplay, muted and playsinline attributes set for video.play() to be successful
    // Without these attributes this.video.play() will throw a NotAllowedError
    // https://developer.apple.com/documentation/webkit/delivering_video_content_for_safari
    if (isSafari) {
      video.setAttribute('autoplay', 'true');
      video.setAttribute('muted', 'true');
      video.setAttribute('playsinline', 'true');
    }

    const constraints: MediaStreamConstraints = {
      video: this._facingMode,
    };

    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (video_nonce != this._video_nonce) {
      // stop was called
      stopStream(newStream);
      throw new ScanCanceled('Canceled after creating new stream');
    }
    //video.src = window.URL.createObjectURL(stream);
    video.srcObject = newStream;
    await video.play();
    if (video_nonce != this._video_nonce) {
      // stop was called
      stopStream(newStream);
      throw new ScanCanceled('Canceled while play stream instruction');
    }
    return video;
  }

  private _stop(): void {
    if (this._video) {
      stopVideo(this._video);
      this._videoPromise = null;
      this._video = null;
    }
    this._video_nonce++;
  }
}

function stopStream(stream: any) {
  stream.getTracks().forEach((track: any) => track.stop());
}

function stopVideo(video: HTMLVideoElement) {
  video.pause();
  if (video.srcObject) stopStream(video.srcObject);
  video.parentElement?.remove();
}
