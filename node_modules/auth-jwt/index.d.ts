declare module "auth-jwt" {
    export function checkToken(token: string, secret: string): Promise<object>;
    export function verify(req: any, secret: string): Promise<object>;
    export function getToken(req: string): Promise<object>;
}
