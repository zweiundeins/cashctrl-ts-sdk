import { CashCtrlHttp, type CashCtrlOptions } from "./http.ts";
import {
  AccountResource,
  CurrencyResource,
  CustomfieldResource,
  DomainResource,
  FileResource,
  FiscalperiodResource,
  HistoryResource,
  InventoryResource,
  JournalResource,
  LocationResource,
  OrderResource,
  PersonResource,
  ReportResource,
  RoundingResource,
  SalaryResource,
  SequencenumberResource,
  SettingResource,
  TaxResource,
  TextResource,
} from "./generated/resources.ts";

/**
 * Typed client for the CashCtrl API.
 *
 * Resources mirror the API's own path structure, so
 * `POST /api/v1/account/costcenter/category/create.json` is reached as
 * `client.account.costcenter.category.create({...})`.
 *
 * ```ts
 * const cc = new CashCtrl({ organisation: "myorg", apiKey: "..." });
 * const accounts = await cc.account.list({ onlyActive: true });
 * const { insertId } = await cc.person.create({ categoryId: 1, ... });
 * ```
 *
 * Every method accepts an optional trailing `AbortSignal`.
 */
export class CashCtrl {
  /** Escape hatch for endpoints you would rather call untyped. */
  readonly http: CashCtrlHttp;

  readonly account: AccountResource;
  readonly currency: CurrencyResource;
  readonly customfield: CustomfieldResource;
  readonly domain: DomainResource;
  readonly file: FileResource;
  readonly fiscalperiod: FiscalperiodResource;
  readonly history: HistoryResource;
  readonly inventory: InventoryResource;
  readonly journal: JournalResource;
  readonly location: LocationResource;
  readonly order: OrderResource;
  readonly person: PersonResource;
  readonly report: ReportResource;
  readonly rounding: RoundingResource;
  readonly salary: SalaryResource;
  readonly sequencenumber: SequencenumberResource;
  readonly setting: SettingResource;
  readonly tax: TaxResource;
  readonly text: TextResource;

  constructor(options: CashCtrlOptions) {
    this.http = new CashCtrlHttp(options);
    this.account = new AccountResource(this.http);
    this.currency = new CurrencyResource(this.http);
    this.customfield = new CustomfieldResource(this.http);
    this.domain = new DomainResource(this.http);
    this.file = new FileResource(this.http);
    this.fiscalperiod = new FiscalperiodResource(this.http);
    this.history = new HistoryResource(this.http);
    this.inventory = new InventoryResource(this.http);
    this.journal = new JournalResource(this.http);
    this.location = new LocationResource(this.http);
    this.order = new OrderResource(this.http);
    this.person = new PersonResource(this.http);
    this.report = new ReportResource(this.http);
    this.rounding = new RoundingResource(this.http);
    this.salary = new SalaryResource(this.http);
    this.sequencenumber = new SequencenumberResource(this.http);
    this.setting = new SettingResource(this.http);
    this.tax = new TaxResource(this.http);
    this.text = new TextResource(this.http);
  }
}
