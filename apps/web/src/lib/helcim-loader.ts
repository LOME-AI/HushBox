const HELCIM_SCRIPT_URL = 'https://secure.myhelcim.com/js/version2.js';

let loadPromise: Promise<void> | null = null;
let isLoaded = false;

/**
 * Loads the Helcim.js script for client-side card tokenization.
 * Uses singleton pattern to avoid loading the script multiple times.
 *
 * @returns Promise that resolves when the script is loaded
 */
export function loadHelcimScript(): Promise<void> {
  if (isLoaded) {
    return Promise.resolve();
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HELCIM_SCRIPT_URL;
    script.async = true;
    script.onload = (): void => {
      isLoaded = true;
      resolve();
    };
    script.onerror = (): void => {
      loadPromise = null;
      reject(new Error('Failed to load Helcim script'));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * Resets the loader state. For testing purposes only.
 */
export function resetHelcimLoader(): void {
  loadPromise = null;
  isLoaded = false;
}

/**
 * Checks if the Helcim script is loaded.
 */
export function isHelcimScriptLoaded(): boolean {
  return isLoaded;
}

/**
 * Interface for the Helcim tokenization result returned via DOM elements.
 */
export interface HelcimTokenResult {
  success: boolean;
  cardToken?: string | undefined;
  cardType?: string | undefined;
  cardLastFour?: string | undefined;
  customerCode?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Reads the Helcim tokenization result from the DOM.
 * Helcim.js populates hidden input fields in a div with id="helcimResults".
 */
export function readHelcimResult(): HelcimTokenResult {
  const responseEl = document.getElementById('response') as HTMLInputElement | null;
  const responseMessageEl = document.getElementById('responseMessage') as HTMLInputElement | null;
  const cardTokenEl = document.getElementById('cardToken') as HTMLInputElement | null;
  const cardTypeEl = document.getElementById('cardType') as HTMLInputElement | null;
  const cardF4L4El = document.getElementById('cardF4L4') as HTMLInputElement | null;
  const customerCodeEl = document.getElementById('customerCode') as HTMLInputElement | null;

  const response = responseEl?.value;
  const responseMessage = responseMessageEl?.value;
  const cardToken = cardTokenEl?.value;
  const cardType = cardTypeEl?.value;
  const cardF4L4 = cardF4L4El?.value;
  const customerCode = customerCodeEl?.value;

  if (response === '1') {
    return {
      success: true,
      cardToken,
      cardType,
      cardLastFour: cardF4L4?.slice(-4),
      customerCode,
    };
  }

  return {
    success: false,
    // Use || instead of ?? to handle empty strings as well as null/undefined
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- need falsy check for empty string
    errorMessage: responseMessage || 'Card tokenization failed',
  };
}
