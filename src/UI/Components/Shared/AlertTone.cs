// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     AlertTone.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.Components.Shared;

/// <summary>
///   The fixed hue an <see cref="Alert" /> renders.
/// </summary>
public enum AlertTone
{
	/// <summary>
	///   A fixed red tone, for a failure.
	/// </summary>
	Error,

	/// <summary>
	///   A fixed amber tone, for a failure the Admin can wait out, such as a rate limit.
	/// </summary>
	Warning,
}
