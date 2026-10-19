// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     LeakyService.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

namespace Architecture.Tests.Fixtures.Exposure;

// CA1515: PublicApiExposureRule inspects only publicly visible types, so these fixtures have to be public.
#pragma warning disable CA1515

public sealed class LeakyService
{
	public Task<HttpClient> GetClientAsync() => throw new NotSupportedException();
}
#pragma warning restore CA1515
