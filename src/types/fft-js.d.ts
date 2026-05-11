declare module "fft.js" {
  type ComplexArray = number[] | Float64Array;
  type RealArray = number[] | Float64Array | Float32Array;

  class FFT {
    constructor(size: number);
    readonly size: number;
    createComplexArray(): number[];
    realTransform(out: ComplexArray, data: RealArray): void;
    transform(out: ComplexArray, data: ComplexArray): void;
    inverseTransform(out: ComplexArray, data: ComplexArray): void;
    completeSpectrum(spectrum: ComplexArray): void;
    fromComplexArray(complex: ComplexArray, storage?: RealArray): RealArray;
    toComplexArray(input: RealArray, storage?: ComplexArray): ComplexArray;
  }

  export = FFT;
}
