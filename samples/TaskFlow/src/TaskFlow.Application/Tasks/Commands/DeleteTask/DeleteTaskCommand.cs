using MediatR;

namespace TaskFlow.Application.Tasks.Commands.DeleteTask;

public record DeleteTaskCommand(int TaskId) : IRequest;
