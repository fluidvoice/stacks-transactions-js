import {
  AuthType,
  AddressHashMode,
  PubKeyEncoding,
  RECOVERABLE_ECDSA_SIG_LENGTH_BYTES
} from './constants'

import {
  BufferArray,
  BufferReader,
  bigIntToHexString,
  hexStringToBigInt
} from './utils';

import {
  Address
} from './types';

import {
  StacksPublicKey,
  StacksPrivateKey
} from './keys';

import {
  StacksMessage
} from './message'

import {
  sha512_256
} from './vendor/js-sha512';

export class SpendingAuthorizationField {
  fieldID: Buffer;
  body: Buffer;
}

export class MessageSignature extends StacksMessage {
  signature: string;

  constructor(signature?: string) {
    super();
    if (signature) {
      let length = Buffer.from(signature, 'hex').byteLength;
      if (length != RECOVERABLE_ECDSA_SIG_LENGTH_BYTES) {
        throw Error('Invalid signature');
      }
    }
    this.signature = signature;
  }
  
  static empty(): MessageSignature {
    let messageSignature = new this();
    messageSignature.signature = 
      Buffer.alloc(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES, 0x00).toString('hex');
    return messageSignature;
  }

  toString(): string {
    return this.signature;
  }

  serialize(): Buffer {
    let bufferArray: BufferArray = new BufferArray();
    bufferArray.appendHexString(this.signature);
    return bufferArray.concatBuffer();
  }

  deserialize(bufferReader: BufferReader) {
    this.signature = bufferReader.read(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES).toString('hex');
  }

}

export class SpendingCondition extends StacksMessage {
  addressHashMode: AddressHashMode;
  signerAddress: Address;
  nonce: BigInt;
  feeRate: BigInt;
  pubKeyEncoding: PubKeyEncoding;
  signature: MessageSignature;
  signaturesRequired: number;

  constructor(
    addressHashMode?: AddressHashMode, 
    pubKey?: string, 
    nonce?: BigInt, 
    feeRate?: BigInt
  ) {
    super();
    this.addressHashMode = addressHashMode;
    if (addressHashMode && pubKey) {
      this.signerAddress = Address.fromPublicKeys(
        0, 
        addressHashMode, 
        1, 
        [new StacksPublicKey(pubKey)]
      );
    }
    this.nonce = nonce;
    this.feeRate = feeRate;
    if (pubKey) {
      this.pubKeyEncoding = new StacksPublicKey(pubKey).compressed() 
        ? PubKeyEncoding.Compressed : PubKeyEncoding.Uncompressed;
    }
    this.signature = MessageSignature.empty();
  }

  singleSig(): boolean {
    if (this.addressHashMode === AddressHashMode.SerializeP2PKH ||
      this.addressHashMode === AddressHashMode.SerializeP2WPKH)
    {
      return true;
    } else {
      return false;
    }
  }

  static makeSigHashPreSign(
    curSigHash: string, 
    authType: AuthType, 
    feeRate: BigInt, 
    nonce: BigInt
  ): string {
    // new hash combines the previous hash and all the new data this signature will add. This
    // includes:
    // * the previous hash
    // * the auth flag
    // * the fee rate (big-endian 8-byte number)
    // * nonce (big-endian 8-byte number)
    let hashLength = 32 + 1 + 8 + 8;

    let sigHash = curSigHash + authType + bigIntToHexString(feeRate, 8) + bigIntToHexString(nonce, 8);

    if (Buffer.from(sigHash, 'hex').byteLength > hashLength) {
      throw Error('Invalid signature hash length');
    }

    return sha512_256(sigHash);
  }

  static makeSigHashPostSign(
    curSigHash: string, 
    publicKey: StacksPublicKey, 
    signature: MessageSignature
  ): string {
    // new hash combines the previous hash and all the new data this signature will add.  This
    // includes:
    // * the public key compression flag
    // * the signature
    let hashLength = 32 + 1 + RECOVERABLE_ECDSA_SIG_LENGTH_BYTES;
    let pubKeyEncoding = publicKey.compressed() ? PubKeyEncoding.Compressed : PubKeyEncoding.Uncompressed;

    let sigHash = curSigHash + pubKeyEncoding + signature.toString();

    if (Buffer.from(sigHash, 'hex').byteLength > hashLength) {
      throw Error('Invalid signature hash length');
    }

    return sha512_256(sigHash);
  }

  static nextSignature(
    curSigHash: string, 
    authType: AuthType, 
    feeRate: BigInt, 
    nonce: BigInt, 
    privateKey: StacksPrivateKey
  ): {
    nextSig: MessageSignature, 
    nextSigHash: string
  } {
    let sigHashPreSign = this.makeSigHashPreSign(curSigHash, authType, feeRate, nonce);
    let signature = privateKey.sign(sigHashPreSign);
    let publicKey = privateKey.getPublicKey();
    let nextSigHash = this.makeSigHashPostSign(sigHashPreSign, publicKey, signature);

    return {
      nextSig: signature,
      nextSigHash: nextSigHash,
    }
  }

  numSignatures(): number {
    return 0;
  }

  serialize(): Buffer {
    let bufferArray: BufferArray = new BufferArray();

    bufferArray.appendHexString(this.addressHashMode);
    bufferArray.appendHexString(this.signerAddress.data);
    bufferArray.appendHexString(bigIntToHexString(this.nonce));
    bufferArray.appendHexString(bigIntToHexString(this.feeRate));

    if (this.addressHashMode === AddressHashMode.SerializeP2PKH ||
      this.addressHashMode === AddressHashMode.SerializeP2WPKH)
    {
      bufferArray.appendHexString(this.pubKeyEncoding);
      bufferArray.push(this.signature.serialize());
    } else if (this.addressHashMode === AddressHashMode.SerializeP2SH ||
      this.addressHashMode === AddressHashMode.SerializeP2WSH)
    {
      // TODO
    }

    return bufferArray.concatBuffer();
  }

  deserialize(bufferReader: BufferReader) {
    this.addressHashMode = bufferReader.read(1).toString('hex') as AddressHashMode;
    let signerPubKeyHash = bufferReader.read(20).toString('hex');
    this.signerAddress = Address.fromData(0, signerPubKeyHash);
    this.nonce = hexStringToBigInt(bufferReader.read(8).toString('hex'));
    this.feeRate = hexStringToBigInt(bufferReader.read(8).toString('hex'));

    if (this.addressHashMode === AddressHashMode.SerializeP2PKH ||
      this.addressHashMode === AddressHashMode.SerializeP2WPKH)
    {
      this.pubKeyEncoding = bufferReader.read(1).toString('hex') as PubKeyEncoding;
      this.signature = MessageSignature.deserialize(bufferReader);
    } else if (this.addressHashMode === AddressHashMode.SerializeP2SH ||
      this.addressHashMode === AddressHashMode.SerializeP2WSH)
    {
      // TODO
    }
  }
}

export class SingleSigSpendingCondition extends SpendingCondition {
  constructor(
    addressHashMode?: AddressHashMode, 
    pubKey?: string, 
    nonce?: BigInt, 
    feeRate?: BigInt
  ) {
    super(addressHashMode, pubKey, nonce, feeRate);
    this.signaturesRequired = 1;
  }

  numSignatures(): number {
    return this.signature.toString() === MessageSignature.empty().toString() ? 0 : 1;
  }
}

export class MultiSigSpendingCondition extends SpendingCondition {
  // TODO
}

export class Authorization extends StacksMessage { 
  authType: AuthType;
  spendingCondition: SpendingCondition;

  constructor(authType?: AuthType, spendingConditions?: SpendingCondition) {
    super();
    this.authType = authType;
    this.spendingCondition = spendingConditions;
  }

  intoInitialSighashAuth() {

  }

  serialize(): Buffer {
    let bufferArray: BufferArray = new BufferArray();
    bufferArray.appendHexString(this.authType);

    switch (this.authType) {
      case AuthType.Standard:
        bufferArray.push(this.spendingCondition.serialize());
        break;
      case AuthType.Sponsored:
        // TODO
        break;
    }
    
    return bufferArray.concatBuffer();
  }

  deserialize(bufferReader: BufferReader) {
    this.authType = bufferReader.read(1).toString("hex") as AuthType;

    switch (this.authType) {
      case AuthType.Standard:
        this.spendingCondition = SpendingCondition.deserialize(bufferReader);
        break;
      case AuthType.Sponsored:
        // TODO
        break;
    }
  }
}

export class StandardAuthorization extends Authorization {
    constructor(spendingCondition: SpendingCondition) {
      super(
        AuthType.Standard,
        spendingCondition
      );
    }
}

export class SponsoredAuthorization extends Authorization {
    constructor(spendingCondition: SpendingCondition) {
      super(
        AuthType.Sponsored,
        spendingCondition
      );
    }
}