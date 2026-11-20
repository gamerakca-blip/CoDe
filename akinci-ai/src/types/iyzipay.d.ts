declare module "iyzipay" {
  type Callback = (err: unknown, result: Record<string, any>) => void;
  interface Resource {
    create(request: Record<string, unknown>, cb: Callback): void;
    retrieve(request: Record<string, unknown>, cb: Callback): void;
  }
  class Iyzipay {
    constructor(config: { apiKey: string; secretKey: string; uri: string });
    checkoutFormInitialize: Resource;
    checkoutForm: Resource;
    static LOCALE: { TR: string; EN: string };
    static CURRENCY: { TRY: string };
    static PAYMENT_GROUP: { PRODUCT: string; LISTING: string; SUBSCRIPTION: string };
    static BASKET_ITEM_TYPE: { PHYSICAL: string; VIRTUAL: string };
  }
  export = Iyzipay;
}
